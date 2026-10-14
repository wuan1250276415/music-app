const fs=require('node:fs'),path=require('node:path');
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
function payload(){
 const credit=[{name:'来源歌手',artist:{id:id(90),name:'来源歌手'}}];
 const track=(n,position,title,length)=>({id:id(n),position,number:String(position),title,length,'artist-credit':credit,recording:{id:id(n+100),title,length,'artist-credit':credit}});
 return {id:id(1),title:'来源专辑',date:'2003-07-31',country:'JP',status:'Official','artist-credit':credit,'release-group':{id:id(2),title:'来源概念','primary-type':'Album','secondary-types':[]},media:[{position:1,format:'Enhanced CD','track-count':1,'track-offset':0,pregap:track(10,0,'来源前导曲',1000),tracks:[track(11,1,'来源正文曲',2000)],'data-tracks':[track(12,2,'安装程序',3000)]}]};
}
function writeMusic(folder){
 fs.mkdirSync(folder,{recursive:true});const rate=44100,bytes=rate*3*4,wav=Buffer.alloc(44+bytes);
 wav.write('RIFF');wav.writeUInt32LE(36+bytes,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(bytes,40);
 fs.writeFileSync(path.join(folder,'mirror.wav'),wav);
 fs.writeFileSync(path.join(folder,'album.cue'),'TITLE "隔离CUE专辑"\nPERFORMER "本地歌手"\nFILE "mirror.wav" WAVE\nTRACK 01 AUDIO\nTITLE "正文曲目"\nINDEX 01 00:01:00\n','utf8');
}
module.exports={id,payload,writeMusic};
