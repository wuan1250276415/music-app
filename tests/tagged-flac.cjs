const fs=require('node:fs'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function u32(value,little=false){const bytes=Buffer.alloc(4);if(little)bytes.writeUInt32LE(value);else bytes.writeUInt32BE(value);return bytes;}
function parts(bytes){
  assert.equal(bytes.subarray(0,4).toString('ascii'),'fLaC');
  const blocks=[];let position=4;
  for(let count=0;count<1024;count++){
    assert.ok(position+4<=bytes.length,'complete FLAC metadata header');
    const flag=bytes[position],length=bytes.readUIntBE(position+1,3),end=position+4+length;
    assert.ok(end<=bytes.length,'complete FLAC metadata block');
    blocks.push({type:flag&127,bytes:bytes.subarray(position+4,end)});position=end;
    if(flag&128){assert.ok(position<bytes.length,'FLAC audio payload');return {blocks,audio:bytes.subarray(position)};}
  }
  throw new Error('Fixture metadata block budget exceeded');
}
function picture(filename,type){
  const image=fs.readFileSync(filename),mime=Buffer.from('image/png'),description=Buffer.from(type===3?'MVP front cover':'MVP back cover');
  assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const depth=image[24],color=image[25];assert.ok(color===2||color===6,'RGB/RGBA fixture image');
  return Buffer.concat([u32(type),u32(mime.length),mime,u32(description.length),description,
    u32(image.readUInt32BE(16)),u32(image.readUInt32BE(20)),u32(depth*(color===6?4:3)),u32(0),u32(image.length),image]);
}
// RFC 9639 sections 8.1, 8.6 and 8.8. Audio frames and STREAMINFO are preserved.
function writeTaggedFlac(source,target,tags,pictures){
  const original=parts(fs.readFileSync(source)),vendor=Buffer.from('Aural MVP fixture');
  const entries=Object.entries(tags).flatMap(([name,value])=>(Array.isArray(value)?value:[value]).map(value=>Buffer.from(`${name}=${value}`,'utf8')));
  const comment=Buffer.concat([u32(vendor.length,true),vendor,u32(entries.length,true),...entries.flatMap(entry=>[u32(entry.length,true),entry])]);
  const blocks=[...original.blocks.filter(block=>block.type!==4&&block.type!==6),{type:4,bytes:comment},...pictures.map(image=>({type:6,bytes:picture(image.path,image.type)}))];
  const encoded=blocks.flatMap((block,index)=>{
    assert.ok(block.bytes.length<=0xffffff);const header=Buffer.alloc(4);header[0]=block.type|(index===blocks.length-1?128:0);header.writeUIntBE(block.bytes.length,1,3);return [header,block.bytes];
  });
  const file=Buffer.concat([Buffer.from('fLaC'),...encoded,original.audio]);
  const result=parts(file);assert.ok(result.blocks[0].bytes.equals(original.blocks[0].bytes));assert.ok(result.audio.equals(original.audio));
  fs.writeFileSync(target,file);
  return {sourceAudioSha256:sha(original.audio),fixtureAudioSha256:sha(result.audio),fixtureSha256:sha(file)};
}
module.exports={writeTaggedFlac};
