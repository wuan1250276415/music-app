// Demonstration only: .invalid is reserved and is never a production data source.
// The example receives a scoped transport; it does not receive the database or vault.
exports.definition = () => ({
 manifest: {
  id:'example-metadata',version:'1',kind:'builtin-provider',apiVersion:{major:1,minor:0},
  hostApiRange:{major:1,minMinor:0,maxMinor:0},platforms:['win32'],architectures:['x64'],
  capabilities:['search'],permissions:{network:[{host:'metadata.example.invalid',subdomains:false}],credentials:[]}
 },
 policy: {
  id:'example-metadata',capabilities:{search:{origin:'https://metadata.example.invalid',path:/^\/v1\/search$/}},
  intervalMs:1,timeoutMs:1000,deadlineMs:3000,maxAttempts:1,maxQueued:4,
  maxResponseBytes:65536,cacheMs:0,reviewMs:60000,
  rights:{display:true,cache:'none',persist:false,label:'仅供契约演示，不允许保存',termsUrl:'https://metadata.example.invalid/terms',verifiedAt:'2026-10-15'}
 }
});
exports.createAdapter = transport => ({
 async search(query,{signal}={}) {
  if(typeof query!=='string'||!query.trim()||query.length>240||/[\u0000-\u001f\u007f]/.test(query))throw new Error('示例查询无效');
  const url=new URL('https://metadata.example.invalid/v1/search');url.searchParams.set('q',query.trim());
  const result=await transport.request('example-metadata','search',url,{'Accept':'application/json'},raw=>{
   if(!raw||!Array.isArray(raw.items)||raw.items.length>25||raw.items.some(item=>!item||typeof item.id!=='string'||!/^[a-z0-9-]{1,64}$/.test(item.id)||typeof item.title!=='string'||item.title.length>240))throw new Error('示例候选格式无效');
   return raw.items.map(item=>({externalId:item.id,title:item.title}));
  },{signal});
  return {provider:'example-metadata',...result};
 }
});
