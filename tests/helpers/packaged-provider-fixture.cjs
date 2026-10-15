const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),http=require('node:http'),net=require('node:net'),{X509Certificate}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {lookup,recording}=require('../audio-fingerprint-fixture.cjs');

exports.createPackagedProviderFixture=async function(scratch){
 const folder=path.join(scratch,'tls');
 execFileSync(process.env.AURAL_PYTHON||'python',[path.join(__dirname,'fixture-certificate.py'),folder],{windowsHide:true,stdio:'pipe'});
 const key=fs.readFileSync(path.join(folder,'key.pem')),cert=fs.readFileSync(path.join(folder,'cert.pem'));
 const fingerprint=new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase(),hosts=['api.acoustid.org','musicbrainz.org'],requests=[],denied=[],sockets=new Set();let gate=null;
 const own=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};
 const server=https.createServer({key,cert,minVersion:'TLSv1.2'},async(req,res)=>{
  try{
   const host=String(req.headers.host||'').split(':')[0],url=new URL(req.url,'https://'+host);if(!hosts.includes(host))throw new Error('Unlisted fixture host');
   let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>131072)throw new Error('Fixture request budget');chunks.push(chunk);}
   let value;
   if(host==='api.acoustid.org'&&url.pathname==='/v2/lookup'&&req.method==='POST'){
    const body=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));requests.push({provider:'acoustid',method:req.method,url:url.href,bodyKeys:[...body.keys()].sort(),keyCorrect:body.get('client')==='aural-fixture-client',fingerprintBytes:body.get('fingerprint')?.length??0,duration:body.get('duration')});
    const current=gate;if(current){gate=null;current.seen();await current.wait;}value=lookup();
   }else if(host==='musicbrainz.org'&&/^\/ws\/2\/recording\/[a-f0-9-]{36}$/.test(url.pathname)&&req.method==='GET'){
    requests.push({provider:'musicbrainz',method:req.method,url:url.href});value=recording(url.pathname.split('/').at(-1));
   }else throw new Error('Unlisted fixture endpoint');
   if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
  }catch(error){if(!res.destroyed){res.writeHead(502);res.end('Isolated fixture refused request');}}
 });
 server.on('connection',own);server.on('tlsClientError',()=>{});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const proxy=http.createServer((req,res)=>{denied.push({method:req.method,target:String(req.url).slice(0,256)});res.writeHead(403);res.end();});
 proxy.on('connection',own);proxy.on('connect',(req,client,head)=>{
  if(!hosts.some(host=>req.url===host+':443')){denied.push({method:'CONNECT',target:String(req.url).slice(0,256)});client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  const upstream=net.connect(server.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(client);client.pipe(upstream);});own(upstream);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 return {port:proxy.address().port,fingerprint,hosts,requests,denied,
  holdNextAcoustid(){if(gate)throw new Error('An owned gate is already armed');let seen,release;const reached=new Promise(resolve=>seen=resolve),wait=new Promise(resolve=>release=resolve);gate={seen,wait,release};return {reached,release};},
  async close(){gate?.release();for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>server.close(resolve))]);key.fill(0);}
 };
};
