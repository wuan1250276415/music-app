export function userError(error:unknown):string {
 return String(error).replace(/^Error: Error invoking remote method '[^']+': (?:Error: )?/,'').replace(/^Error: /,'');
}
