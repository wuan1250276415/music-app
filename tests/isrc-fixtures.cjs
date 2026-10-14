const fs=require('node:fs'),assert=require('node:assert/strict');
function synchsafe(value){const b=Buffer.alloc(4);for(let n=3;n>=0;n--){b[n]=value&127;value=Math.floor(value/128);}assert.equal(value,0);return b;}
function writeISRCMP3(source,target,code){
 const original=fs.readFileSync(source);assert.equal(original.subarray(0,3).toString(),'ID3');assert.equal(original[3],4);assert.equal(original[5],0);
 const size=original.subarray(6,10).reduce((n,v)=>n*128+v,0),value=Buffer.concat([Buffer.from([0]),Buffer.from(code,'ascii')]),frame=Buffer.concat([Buffer.from('TSRC'),synchsafe(value.length),Buffer.alloc(2),value]),head=Buffer.from(original.subarray(0,10));synchsafe(size+frame.length).copy(head,6);
 fs.writeFileSync(target,Buffer.concat([head,original.subarray(10,10+size),frame,original.subarray(10+size)]));
 assert.ok(fs.readFileSync(target).subarray(10+size+frame.length).equals(original.subarray(10+size)));
}
module.exports={writeISRCMP3};
