export interface CueDirective {command:string;value:string}
export interface CueFileDeclaration {token:string;type:string}
const whitespace=(value:string)=>/\s/.test(value);
const word=(code:number)=>code>=48&&code<=57||code>=65&&code<=90||code>=97&&code<=122||code===95;
// The former directive regexp's word / whitespace / body ranges are consumed
// once. Do not put an overlapping whitespace quantifier before a greedy body.
export function readCueDirective(line:string):CueDirective|null {
 if(!line||line.length>16384)return null;let at=0;while(at<line.length&&word(line.charCodeAt(at)))at++;
 if(!at||at===line.length||!whitespace(line[at]))return null;const command=line.slice(0,at).toUpperCase();
 while(at<line.length&&whitespace(line[at]))at++;if(at===line.length)return null;
 const value=line.slice(at);for(let i=0;i<value.length;i++)if(value[i]==='\r'||value[i]==='\n'||value[i]==='\u2028'||value[i]==='\u2029')return null;
 return {command,value:value.trim()};
}
function parts(value:string):CueFileDeclaration|null {
 if(!value||value.length>16384)return null;let at=value.length-1;while(at>=0&&!whitespace(value[at]))at--;
 if(at<1)return null;const type=value.slice(at+1);if(!/^[A-Z0-9_]+$/i.test(type))return null;
 const token=value.slice(0,at).trimEnd();if(!token)return null;return {token,type:type.toUpperCase()};
}
// Current grammar: a quoted token must finish at its matching unescaped quote.
// The original token is returned intact for the established decodeValue rules.
export function readCueFileDeclaration(value:string):CueFileDeclaration|null {
 const result=parts(value);if(!result)return null;const {token}=result;
 if(!token.startsWith('"')){for(let i=0;i<token.length;i++)if(token[i]==='"'||whitespace(token[i]))return null;return result;}
 for(let at=1;at<token.length;at++){
  if(token[at]==='\\'){if(++at===token.length)return null;continue;}
  if(token[at]==='"')return at===token.length-1?result:null;
 }
 return null;
}
// Only for replaying retained parser3 snapshots (FLAC text source parser1).
// The old (\\.|[^"])* language permits literal backslashes, so each internal
// quote only needs a directly preceding slash; all other characters can be
// singleton tokens. Its unquoted fallback accepts any non-whitespace token.
// This is a linear language check, never the old backtracking regexp.
export function readCueFileDeclarationLegacy3(value:string):CueFileDeclaration|null {
 const result=parts(value);if(!result)return null;const {token}=result;
 if(token.length>=2&&token.startsWith('"')&&token.endsWith('"')){
  let valid=true;for(let at=1;at<token.length-1;at++)if(token[at]==='"'&&token[at-1]!=='\\'){valid=false;break;}
  if(valid)return result;
 }
 for(let at=0;at<token.length;at++)if(whitespace(token[at]))return null;
 return result;
}
