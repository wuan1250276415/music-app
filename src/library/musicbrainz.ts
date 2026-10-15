import {FINGERPRINT_RECIPE} from '../shared/audio-fingerprint.js';
import {MetadataReviewCache} from './metadata-review-cache.js';
import {batchLookup} from '../shared/metadata-batch-review.js';
import {normalizeISRC} from '../shared/isrc.js';
import {ProviderBroker,type ProviderPolicy} from './provider-broker.js';
import {RELEASE} from '../shared/release.js';
import { randomUUID } from 'node:crypto';
import type { LibraryItem, MetadataCandidate,MetadataProviderCredit } from '../shared/contracts.js';
import {rankMetadataCandidate} from './metadata-match-ranking.js';
import {parseMetadataReleaseContext} from './metadata-release-context.js';

export const musicBrainzPolicy:ProviderPolicy={id:'musicbrainz',capabilities:{'isrc-lookup':{origin:'https://musicbrainz.org',path:/^\/ws\/2\/isrc\/[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/},'recording-lookup':{origin:'https://musicbrainz.org',path:/^\/ws\/2\/recording\/[0-9a-f-]{36}$/},'recording-search':{origin:'https://musicbrainz.org',path:/^\/ws\/2\/recording\/$/},'recording-releases':{origin:'https://musicbrainz.org',path:/^\/ws\/2\/release$/},'recording-credit':{origin:'https://musicbrainz.org',path:/^\/ws\/2\/recording\/[0-9a-f-]{36}$/},'release-context':{origin:'https://musicbrainz.org',path:/^\/ws\/2\/release\/[0-9a-f-]{36}$/},'release-credit':{origin:'https://musicbrainz.org',path:/^\/ws\/2\/release\/[0-9a-f-]{36}$/}},intervalMs:1100,timeoutMs:8000,deadlineMs:40000,maxAttempts:3,maxQueued:32,maxResponseBytes:2000000,cacheMs:60000,reviewMs:600000,rights:{display:true,cache:'memory',persist:false,label:'短期搜索预览；确认后仅保存已核实核心字段',termsUrl:'https://musicbrainz.org/doc/MusicBrainz_API',verifiedAt:'2026-10-01'}};
type Fetcher = typeof fetch;
type Recording = { id?: unknown; title?: unknown; score?: unknown; length?: unknown; 'artist-credit'?: unknown; releases?: unknown };
type Release = { id?: unknown; title?: unknown; date?: unknown };
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validContact(value: string): boolean {
  const contact=value.trim();
  if (contact.length<5 || contact.length>160 || /[\r\n()\u0000-\u001f\u007f-\uffff]/.test(contact)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) || /^https:\/\/[a-z0-9.-]+(?:\/[^\s]*)?$/i.test(contact);
}

function creditName(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.slice(0,64).map(part => {
    if (typeof part==='string') return part.slice(0,80);
    if (!part || typeof part!=='object') return '';
    const record=part as {name?:unknown;artist?:{name?:unknown};joinphrase?:unknown};
    return plain(record.name ?? record.artist?.name)+(typeof record.joinphrase==='string'?record.joinphrase.slice(0,80):'');
  }).join('').trim().slice(0,4096);
}

function plain(value: unknown, max=240): string {
  return typeof value==='string' ? value.trim().slice(0,max) : '';
}

function providerCredits(value:unknown):MetadataProviderCredit[]{
  if(!Array.isArray(value)||!value.length||value.length>64)throw new Error('候选署名缺失或超过 64 个成员');
  const result:MetadataProviderCredit[]=[];
  const text=(value:unknown,required=false):string=>{if(value===undefined||value===null){if(required)throw new Error('候选署名文字缺失');return '';}if(typeof value!=='string'||value.length>240||/[\u0000-\u001f\u007f]/.test(value)||required&&!value.trim())throw new Error('候选署名文字无效或过长');return value.trim();};
  const join=(value:unknown):string=>{if(value===undefined)return '';if(typeof value!=='string'||value.length>80||/[\u0000-\u001f\u007f]/.test(value))throw new Error('候选署名连接词无效');return value;};
  for(const part of value){
    if(typeof part==='string'){if(!result.length)throw new Error('候选署名顺序无效');const last=result.at(-1)!;last.joinPhrase=join(last.joinPhrase+part);continue;}
    if(!part||typeof part!=='object')throw new Error('候选署名成员无效');const record=part as {name?:unknown;joinphrase?:unknown;artist?:{id?:unknown;name?:unknown;'sort-name'?:unknown;disambiguation?:unknown}};
    if(!record.artist||!MBID.test(String(record.artist.id??'')))throw new Error('候选艺人身份不完整');const name=text(record.artist.name,true);
    result.push({externalId:String(record.artist.id).toLowerCase(),name,creditedName:record.name==null?name:text(record.name,true),joinPhrase:join(record.joinphrase),sortName:text(record.artist['sort-name']),disambiguation:text(record.artist.disambiguation)});
  }return result;
}

export interface MusicBrainzEntry {itemId:string;candidate:MetadataCandidate;expires:number;requestId?:string;authority?:string;metadataFingerprint?:string;reviewToken?:string;context?:Pick<LibraryItem,'title'|'artist'|'album'|'durationSeconds'>}
export class MusicBrainzProvider {
  private readonly broker:ProviderBroker;private readonly ownsBroker:boolean;
  private readonly candidates=new Map<string,MusicBrainzEntry>();private readonly reviews:MetadataReviewCache;
  private readonly releaseCursors=new Map<string,{itemId:string;recordingId:string;offset:number;expires:number;requestId:string}>();
  private readonly cleanup:NodeJS.Timeout;
  constructor(private readonly getContact:()=>string,fetcher:Fetcher=fetch,broker?:ProviderBroker,private readonly referenceAuthority?:(itemId:string)=>string|null,private readonly metadataAuthority?:(itemId:string)=>string|null){this.reviews=new MetadataReviewCache(id=>this.referenceAuthority?.(id)??null,id=>this.metadataAuthority?.(id)??null);this.ownsBroker=!broker;this.broker=broker??new ProviderBroker(fetcher);if(!broker)this.broker.register(musicBrainzPolicy);this.cleanup=setInterval(()=>this.prune(),15000);this.cleanup.unref();}
  private prune():void{this.reviews.prune();for(const [token,value] of this.candidates)if(value.expires<=Date.now())this.candidates.delete(token);for(const [token,value] of this.releaseCursors)if(value.expires<=Date.now())this.releaseCursors.delete(token);}
  invalidate(requestId?:string):void{if(requestId===undefined){this.candidates.clear();this.releaseCursors.clear();this.reviews.clear();}else{this.reviews.invalidate(requestId);for(const [token,value] of this.candidates)if(value.requestId===requestId)this.candidates.delete(token);for(const [token,value] of this.releaseCursors)if(value.requestId===requestId)this.releaseCursors.delete(token);}}
  dispose():void{clearInterval(this.cleanup);this.invalidate();if(this.ownsBroker)this.broker.dispose();}
  resolve(itemId: string, token: string): MetadataCandidate | null {
    this.prune();const found=this.entry(token);
    if(!found||found.itemId!==itemId||found.expires<=Date.now())return null;
    if(found.authority!==undefined){let current:string|null=null;try{current=this.referenceAuthority?.(itemId)??null;}catch{/* Removed/changed local entity invalidates its candidates. */}if(current!==found.authority){this.candidates.delete(token);return null;}}
    if(found.metadataFingerprint!==undefined){let current:string|null=null;try{current=this.metadataAuthority?.(itemId)??null;}catch{}if(current!==found.metadataFingerprint)return null;}
    return found.candidate;
  }

  private entry(token:string):MusicBrainzEntry|undefined {return this.reviews.get(token)??this.candidates.get(token);}
  beginReview(ids:string[],deadline?:number){if(!this.referenceAuthority||!this.metadataAuthority)throw new Error('批量预览来源核对未配置');return this.reviews.start(ids,deadline);}
  reviewStatus(token:string){return this.reviews.status(token);}
  closeReview(token:string):void{this.reviews.close(token);}
  checkReview(token:string,itemId:string):string{return new Date(this.reviews.check(token,itemId).expires).toISOString();}
  retainReview(token:string,itemId:string,candidates:MetadataCandidate[],authority:string,metadata:string):MetadataCandidate[]{
    const entries=candidates.map(c=>{const entry=this.entry(c.token);if(!entry||!this.resolve(itemId,c.token))throw new Error('批量候选已失效，请重新查询');return entry;});
    const retained=this.reviews.retain(token,itemId,entries,authority,metadata);for(const entry of entries)this.candidates.delete(entry.candidate.token);return retained.map(e=>structuredClone(e.candidate));
  }
  batchCandidate(itemId:string,token:string):MetadataCandidate|null {const candidate=this.resolve(itemId,token),entry=this.entry(token);return candidate&&entry?.authority?{...structuredClone(candidate),batchLookup:batchLookup(candidate,entry.authority)}:null;}
  private store(entries:MusicBrainzEntry[],parent?:MusicBrainzEntry):MetadataCandidate[]{
    if(parent?.reviewToken){if(!parent.authority||!parent.metadataFingerprint)throw new Error('批量来源快照缺失');return this.reviews.retain(parent.reviewToken,parent.itemId,entries,parent.authority,parent.metadataFingerprint,true).map(e=>structuredClone(e.candidate));}
    for(const entry of entries)this.candidates.set(entry.candidate.token,entry);while(this.candidates.size>400)this.candidates.delete(this.candidates.keys().next().value!);return entries.map(e=>e.candidate);
  }

  async creditDetails(itemId:string,token:string,options:{signal?:AbortSignal;fresh?:boolean;requestId:string}):Promise<MetadataCandidate>{
    const original=this.resolve(itemId,token);if(!original)throw new Error('候选已过期，请重新匹配');const contact=this.getContact();if(!validContact(contact))throw new Error('请先填写公开联系信息');
    const signal=AbortSignal.any([AbortSignal.timeout(40000),...(options.signal?[options.signal]:[])]),headers={'User-Agent':`AuralPrototype/${RELEASE.appVersion} (${contact})`,'Accept':'application/json'};
    const lookup=async(kind:'recording'|'release',externalId:string)=>{
      if(!MBID.test(externalId))throw new Error('候选标识无效');const url=new URL(`https://musicbrainz.org/ws/2/${kind}/${externalId.toLowerCase()}`);url.searchParams.set('inc','artist-credits');url.searchParams.set('fmt','json');
      return this.broker.request('musicbrainz',`${kind}-credit`,url,headers,payload=>{if(!payload||typeof payload!=='object')throw new Error('署名查询返回了无效数据');const value=payload as {id?:unknown;title?:unknown;'artist-credit'?:unknown};if(String(value.id).toLowerCase()!==externalId.toLowerCase())throw new Error('署名返回的身份与请求不一致');return {title:plain(value.title)||null,credits:providerCredits(value['artist-credit'])};},{...options,signal});
    };
    const recording=await lookup('recording',original.recordingId),release=original.releaseId?await lookup('release',original.releaseId):null;
    signal.throwIfAborted();if(this.resolve(itemId,token)!==original)throw new Error('原候选已取消，请重新匹配');
    const expires=Math.min(Date.parse(original.expiresAt!),Date.parse(recording.expiresAt),release?Date.parse(release.expiresAt):Infinity);if(expires<=Date.now())throw new Error('候选确认期限已过，请重新匹配');
    const candidate:MetadataCandidate={...original,token:randomUUID(),title:recording.value.title??original.title,album:release?.value.title??original.album,artist:recording.value.credits.map(value=>value.creditedName+value.joinPhrase).join(''),recordingCredits:recording.value.credits,releaseCredits:release?.value.credits,recordingCreditAt:recording.fetchedAt,releaseCreditAt:release?.fetchedAt,expiresAt:new Date(expires).toISOString(),cacheHit:recording.cacheHit&&(!release||release.cacheHit)};
    const parent=this.entry(token)!,local=parent.context;if(local){const ranked=rankMetadataCandidate(local,candidate);candidate.score=ranked.score;candidate.matchEvidence=ranked.matchEvidence;}return this.store([{itemId,candidate,expires,requestId:options.requestId,context:local,authority:parent.authority}],parent)[0];
  }

  async releaseEditions(itemId:string,token:string,options:{signal?:AbortSignal;fresh?:boolean;requestId:string;cursor?:string}):Promise<Omit<import('../shared/metadata-editions.js').MetadataEditionsPage,'itemId'|'token'|'fingerprint'|'requestId'|'recordingId'>>{
    const original=this.resolve(itemId,token);if(!original)throw new Error('候选已过期，请重新匹配');
    const cursor=options.cursor?this.releaseCursors.get(options.cursor):null;
    if(options.cursor&&(!cursor||cursor.itemId!==itemId||cursor.recordingId!==original.recordingId||cursor.expires<=Date.now()))throw new Error('发行版分页已过期或不属于当前录音');
    const offset=cursor?.offset??0,contact=this.getContact();if(!validContact(contact))throw new Error('请先填写公开联系信息');
    const url=new URL('https://musicbrainz.org/ws/2/release');url.searchParams.set('recording',original.recordingId.toLowerCase());url.searchParams.set('limit','25');url.searchParams.set('offset',String(offset));url.searchParams.set('inc','media');url.searchParams.set('fmt','json');
    const envelope=await this.broker.request('musicbrainz','recording-releases',url,{'User-Agent':`AuralPrototype/${RELEASE.appVersion} (${contact})`,'Accept':'application/json'},payload=>{
      const v=payload as {releases?:unknown;'release-count'?:unknown;'release-offset'?:unknown};
      if(!v||typeof v!=='object'||!Array.isArray(v.releases)||v.releases.length>25||!Number.isSafeInteger(v['release-count'])||Number(v['release-count'])<0||Number(v['release-count'])>5000000||v['release-offset']!==offset||v.releases.length&&offset+v.releases.length>Number(v['release-count']))throw new Error('发行版分页返回无效数据');
      const seen=new Set<string>();
      const values=v.releases.map(raw=>{
        const release=raw as {id?:unknown;title?:unknown;date?:unknown;country?:unknown;status?:unknown;disambiguation?:unknown;barcode?:unknown;media?:unknown};
        if(!release||typeof release!=='object'||!MBID.test(String(release.id??''))||!plain(release.title)||seen.has(String(release.id).toLowerCase()))throw new Error('发行版身份缺失或重复');seen.add(String(release.id).toLowerCase());
        if(release.media!==undefined&&(!Array.isArray(release.media)||release.media.length>64))throw new Error('发行版介质范围无效');
        const formats=Array.isArray(release.media)?[...new Set(release.media.map(value=>plain((value as {format?:unknown})?.format,32)).filter(Boolean))]:[];
        return {releaseId:String(release.id).toLowerCase(),album:plain(release.title),date:plain(release.date,32)||null,edition:{country:plain(release.country,16)||null,status:plain(release.status,32)||null,disambiguation:plain(release.disambiguation)||null,barcode:plain(release.barcode,64)||null,format:formats.join(' / ').slice(0,240)||null}};
      });return {values,total:Number(v['release-count']),returned:v.releases.length};
    },options);
    options.signal?.throwIfAborted();if(this.resolve(itemId,token)!==original)throw new Error('原候选已取消，请重新匹配');
    const expires=Math.min(Date.parse(original.expiresAt!),Date.parse(envelope.expiresAt),cursor?.expires??Infinity);if(expires<=Date.now())throw new Error('发行版确认期限已过，请重新匹配');
    const parent=this.entry(token)!;if(!parent.reviewToken){this.candidates.delete(token);this.candidates.set(token,parent);}
    const candidates=envelope.value.values.map(value=>{let candidate:MetadataCandidate={...original,...value,releaseCredits:undefined,releaseCreditAt:undefined,token:randomUUID(),fetchedAt:envelope.fetchedAt,expiresAt:new Date(expires).toISOString(),cacheHit:envelope.cacheHit};const local=parent.context;if(local)candidate=rankMetadataCandidate(local,candidate);return {itemId,candidate,expires,requestId:options.requestId,context:local,authority:parent.authority};});
    const stored=this.store(candidates,parent);
    let nextCursor:string|null=null;
    if(envelope.value.returned>0&&offset+envelope.value.returned<envelope.value.total){nextCursor=randomUUID();this.releaseCursors.set(nextCursor,{itemId,recordingId:original.recordingId,offset:offset+envelope.value.returned,expires,requestId:options.requestId});while(this.releaseCursors.size>128)this.releaseCursors.delete(this.releaseCursors.keys().next().value!);}
    return {candidates:stored,offset,total:envelope.value.total,nextCursor,fetchedAt:envelope.fetchedAt,expiresAt:new Date(expires).toISOString(),cacheHit:envelope.cacheHit};
  }

  async releaseContext(itemId:string,token:string,options:{signal?:AbortSignal;fresh?:boolean;requestId:string}):Promise<{context:import('../shared/metadata-release-context.js').MetadataReleaseContext;fetchedAt:string;expiresAt:string;cacheHit:boolean}>{
    const original=this.resolve(itemId,token);if(!original?.releaseId)throw new Error('候选没有具体发行版，请先选择发行版');
    const contact=this.getContact();if(!validContact(contact))throw new Error('请先填写公开联系信息');
    const url=new URL(`https://musicbrainz.org/ws/2/release/${original.releaseId.toLowerCase()}`);url.searchParams.set('inc','artist-credits+labels+recordings+release-groups');url.searchParams.set('fmt','json');
    const result=await this.broker.request('musicbrainz','release-context',url,{'User-Agent':`AuralPrototype/${RELEASE.appVersion} (${contact})`,'Accept':'application/json'},payload=>parseMetadataReleaseContext(payload,original.releaseId!,providerCredits),options);
    options.signal?.throwIfAborted();if(this.resolve(itemId,token)!==original)throw new Error('原候选已取消，请重新匹配');
    const expires=Math.min(Date.parse(original.expiresAt!),Date.parse(result.expiresAt));if(expires<=Date.now())throw new Error('专辑上下文已过期，请重新匹配');
    return {context:result.value,fetchedAt:result.fetchedAt,expiresAt:new Date(expires).toISOString(),cacheHit:result.cacheHit};
  }

  private lookupValues(payload:unknown,expectedId?:string) {
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('录音查询返回无效数据');
    const recording=payload as Recording,recordingId=String(recording.id??'').toLowerCase();if(!MBID.test(recordingId)||expectedId&&recordingId!==expectedId.toLowerCase())throw new Error('返回录音身份与已确认标识不同，请先核对本地引用');
    const title=plain(recording.title),artist=creditName(recording['artist-credit']);if(!title||!artist)throw new Error('录音查询缺少歌名或署名');
    if(recording.releases!==undefined&&(!Array.isArray(recording.releases)||recording.releases.length>25))throw new Error('录音查询发行版范围无效');
    const releases=Array.isArray(recording.releases)?recording.releases as Release[]:[],seen=new Set<string>(),choices=releases.length?releases:[null];
    return choices.map(release=>{
      const releaseId=release===null?null:String(release?.id??'').toLowerCase();if(release!==null&&(!MBID.test(releaseId!)||!plain(release?.title)||seen.has(releaseId!)))throw new Error('录音查询发行版身份缺失或重复');if(releaseId)seen.add(releaseId);
      return {provider:'musicbrainz' as const,recordingId,releaseId,title,artist,album:releaseId?plain(release?.title):null,date:releaseId?plain(release?.date,32)||null:null,durationSeconds:typeof recording.length==='number'&&Number.isSafeInteger(recording.length)&&recording.length>0&&recording.length<=604800000?recording.length/1000:null,score:0,sourceUrl:`https://musicbrainz.org/recording/${recordingId}`};
    });
  }
  private async lookupRecording(recordingId:string,options:{signal?:AbortSignal;fresh?:boolean;requestId?:string}) {
    const url=new URL(`https://musicbrainz.org/ws/2/recording/${recordingId.toLowerCase()}`);url.searchParams.set('inc','artist-credits+releases');url.searchParams.set('fmt','json');
    return this.broker.request('musicbrainz','recording-lookup',url,{'User-Agent':`AuralPrototype/${RELEASE.appVersion} (${this.getContact()})`,'Accept':'application/json'},payload=>this.lookupValues(payload,recordingId),options);
  }
  private async lookupISRC(isrc:string,options:{signal?:AbortSignal;fresh?:boolean;requestId?:string}) {
    const url=new URL(`https://musicbrainz.org/ws/2/isrc/${isrc}`);url.searchParams.set('inc','artist-credits+releases');url.searchParams.set('fmt','json');
    return this.broker.request('musicbrainz','isrc-lookup',url,{'User-Agent':`AuralPrototype/${RELEASE.appVersion} (${this.getContact()})`,'Accept':'application/json'},payload=>{
      if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('录音编码查询返回无效数据');
      const v=payload as {isrc?:unknown;recordings?:unknown};if(normalizeISRC(v.isrc)!==isrc||!Array.isArray(v.recordings)||v.recordings.length>100)throw new Error('录音编码查询的编码或候选范围无效');
      const seen=new Set<string>();return v.recordings.flatMap(raw=>{const values=this.lookupValues(raw),id=values[0].recordingId;if(seen.has(id))throw new Error('录音编码查询返回重复录音身份');seen.add(id);return values;});
    },options);
  }

  async search(item: LibraryItem,options:{signal?:AbortSignal;fresh?:boolean;requestId?:string;recordingAuthority?:{fingerprint:string;selectedId?:string;isrc?:string};fingerprintEvidence?:{kind:'fingerprint';recordingId:string;acoustidId:string;score:number;algorithm:typeof FINGERPRINT_RECIPE;metadata:string;expiresAt:string}}={}): Promise<MetadataCandidate[]> {
    const contact=this.getContact();
    if (!validContact(contact)) throw new Error('请先在元数据面板填写维护者公开邮箱或 HTTPS 项目网址');
    for (const [token,entry] of this.candidates) if (entry.expires<=Date.now()) this.candidates.delete(token);
    options.signal?.throwIfAborted();const title=item.title.trim().slice(0,500);
    const authority=options.recordingAuthority?.fingerprint,selectedId=options.recordingAuthority?.selectedId,isrc=options.recordingAuthority?.isrc;
    if(authority!==undefined&&(!this.referenceAuthority||this.referenceAuthority(item.id)!==authority))throw new Error('录音身份已变化，请重新匹配');
    const evidence=options.fingerprintEvidence;if(evidence&&(!selectedId||evidence.recordingId!==selectedId||!MBID.test(evidence.acoustidId)||!Number.isFinite(evidence.score)||evidence.score<0||evidence.score>1||evidence.algorithm!==FINGERPRINT_RECIPE||!Number.isFinite(Date.parse(evidence.expiresAt))||Date.parse(evidence.expiresAt)<=Date.now()||this.metadataAuthority?.(item.id)!==evidence.metadata))throw new Error('指纹来源已失效或与所选录音不符');
    if(selectedId!==undefined&&!MBID.test(selectedId))throw new Error('已确认录音标识无效');
    if(isrc!==undefined&&normalizeISRC(isrc)!==isrc||selectedId&&isrc)throw new Error('录音编码查询依据无效');
    if (!selectedId&&!isrc&&(!title || title==='未知标题')) throw new Error('曲目标题不足以搜索');
    const artist=item.artist==='未知艺术家' ? '' : item.artist.trim().slice(0,500);
    const search=[title,artist].filter(Boolean).join(' ');
    const url=new URL('https://musicbrainz.org/ws/2/recording/');
    url.searchParams.set('query',search);
    url.searchParams.set('dismax','true');
    url.searchParams.set('limit','8');
    url.searchParams.set('fmt','json');
    const envelope=selectedId?await this.lookupRecording(selectedId,options):isrc?await this.lookupISRC(isrc,options):await this.broker.request('musicbrainz','recording-search',url,{'User-Agent':`AuralPrototype/${RELEASE.appVersion} (${contact})`,'Accept':'application/json'},payload=>{
      if(!payload||typeof payload!=='object'||!Array.isArray((payload as {recordings?:unknown}).recordings))throw new Error('MusicBrainz 返回了无效数据');
      const values:Array<Omit<MetadataCandidate,'token'|'fetchedAt'|'expiresAt'|'cacheHit'>>=[];
      for(const recording of (payload as {recordings:Recording[]}).recordings.slice(0,8)){
        if(!recording||typeof recording!=='object'||!MBID.test(String(recording.id??'')))continue;
        const title=plain(recording.title),artist=creditName(recording['artist-credit']);if(!title||!artist)continue;
        const releases=Array.isArray(recording.releases)?recording.releases.slice(0,25) as Release[]:[],choices=releases.length?releases:[null];
        for(const release of choices){const releaseId=release&&MBID.test(String(release.id??''))?String(release.id):null;values.push({provider:'musicbrainz',recordingId:String(recording.id),releaseId,title,artist,album:releaseId?plain(release?.title)||null:null,date:releaseId?plain(release?.date,32)||null:null,durationSeconds:typeof recording.length==='number'&&Number.isSafeInteger(recording.length)&&recording.length>0&&recording.length<=604800000?recording.length/1000:null,score:Math.max(0,Math.min(100,Number(recording.score)||0)),sourceUrl:`https://musicbrainz.org/recording/${recording.id}`});}
      }return values;
    },options);
    options.signal?.throwIfAborted();
    if(authority!==undefined&&this.referenceAuthority?.(item.id)!==authority)throw new Error('查询期间录音身份已变化，请重新匹配');
    if(evidence&&this.metadataAuthority?.(item.id)!==evidence.metadata)throw new Error('指纹歌曲来源在读取期间已变化');
    const expiresAt=evidence?new Date(Math.min(Date.parse(evidence.expiresAt),Date.parse(envelope.expiresAt))).toISOString():envelope.expiresAt;
    const context={title:item.title,artist:item.artist,album:item.album,durationSeconds:item.durationSeconds};
    const result: MetadataCandidate[]=[];
    const perRecording=new Map<string,number>();
    for(const candidate of envelope.value.map(value=>rankMetadataCandidate(item,{...value,token:randomUUID(),fetchedAt:envelope.fetchedAt,expiresAt,cacheHit:envelope.cacheHit})).sort((a,b)=>b.score-a.score||a.recordingId.localeCompare(b.recordingId)||String(a.releaseId??'').localeCompare(String(b.releaseId??'')))){const count=perRecording.get(candidate.recordingId)??0;if(count>=(isrc?1:3))continue;perRecording.set(candidate.recordingId,count+1);result.push(candidate);this.candidates.set(candidate.token,{itemId:item.id,candidate,expires:Date.parse(expiresAt),requestId:options.requestId,context,authority,...(evidence?{metadataFingerprint:evidence.metadata}:{})});if(evidence){candidate.matchEvidence!.retrieval={kind:'fingerprint',recordingId:evidence.recordingId,acoustidId:evidence.acoustidId,score:evidence.score,algorithm:evidence.algorithm};candidate.matchEvidence!.warnings.push('音频指纹关联不是身份或发行版确认，请核对录音版本');}else if(selectedId)candidate.matchEvidence!.retrieval={kind:'confirmed-recording',recordingId:selectedId.toLowerCase()};if(isrc){candidate.matchEvidence!.retrieval={kind:'isrc',isrc,recordingCount:new Set(envelope.value.map(c=>c.recordingId)).size};candidate.matchEvidence!.warnings.push('录音编码仅是证据之一，不能自动确认录音或发行版');}if(result.length>=(isrc?100:20))break;}
    while(this.candidates.size>400){const first=this.candidates.keys().next().value;if(first===undefined)break;this.candidates.delete(first);}return result.sort((a,b)=>b.score-a.score||a.recordingId.localeCompare(b.recordingId)||String(a.releaseId??'').localeCompare(String(b.releaseId??'')));
  }
}
