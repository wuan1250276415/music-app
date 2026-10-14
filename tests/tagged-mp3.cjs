const fs=require('node:fs');
const path=require('node:path');
function size(value){return Buffer.from([(value>>>21)&127,(value>>>14)&127,(value>>>7)&127,value&127]);}
function decode(bytes){return (bytes[0]<<21)|(bytes[1]<<14)|(bytes[2]<<7)|bytes[3];}
function frame(id,value){const body=Buffer.concat([Buffer.from([3]),Buffer.from(value,'utf8')]);return Buffer.concat([Buffer.from(id),size(body.length),Buffer.alloc(2),body]);}
exports.writeTaggedMp3=(filename,options={})=>{
  const original=fs.readFileSync(path.join(__dirname,'fixtures','embedded-cover.mp3'));
  const end=10+decode(original.subarray(6,10));let cover;
  for(let offset=10;offset+10<=end;){
    const length=decode(original.subarray(offset+4,offset+8));
    if(original.toString('ascii',offset,offset+4)==='APIC')cover=original.subarray(offset,offset+10+length);
    if(!length)break;offset+=10+length;
  }
  const tags=[frame('TIT2',options.title??'合作作品'),frame('TPE1','甲 feat. 乙'),frame('TXXX','Artists\0甲\0乙\0AC/DC'),
    frame('TPE2','合集艺人'),frame('TALB','同名专辑'),frame('TCON','Jazz\0电子'),frame('TCOM','作曲家'),frame('TPE3','指挥家'),
    frame('TRCK','1'),frame('TPOS',String(options.disc??1)),frame('TDRC',options.date??'2000')];
  if(cover)tags.push(cover);
  const body=Buffer.concat(tags);
  fs.writeFileSync(filename,Buffer.concat([Buffer.from([73,68,51,4,0,0]),size(body.length),body,original.subarray(end)]));
};
