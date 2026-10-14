import type {DsdPcmConversion} from './contracts.js';
export const DSD_PCM_PROFILE='ff-dsd96-swr128-kaiser9-c0.5-v1';
export function validDsdPcmConversion(value:unknown):value is DsdPcmConversion {
  if(!value||typeof value!=='object')return false;
  const data=value as DsdPcmConversion;
  return data.kind==='dsd-to-pcm'&&['dsf','dff'].includes(data.container)&&
    [2822400,5644800,11289600].includes(data.bitRate)&&typeof data.validBitSamples==='string'&&
    /^[1-9]\d{0,19}$/.test(data.validBitSamples)&&BigInt(data.validBitSamples)<=0xffffffffffffffffn&&
    BigInt(data.validBitSamples)%8n===0n&&data.intermediateRate===data.bitRate/8&&
    data.pcmRate===176400&&data.gainDb===0&&data.profile===DSD_PCM_PROFILE&&data.delayCompensation==='pending';
}
