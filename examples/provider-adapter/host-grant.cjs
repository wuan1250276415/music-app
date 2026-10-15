// This is owned and reviewed by the host, independently of the adapter manifest.
module.exports=()=>({id:'example-metadata',version:'1',capabilities:['search'],
 permissions:{network:[{host:'metadata.example.invalid',subdomains:false}],credentials:[]}});
