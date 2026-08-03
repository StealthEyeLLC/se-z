const dynamicKeys = new Set(['timestamp','createdAt','startedAt','completedAt','updatedAt','pid','pgid','jobId','sessionId','artifactId','receiptId','requestId','nonce','signature','hostname','machineIdSha256','streamHandle','releasePath']);
const keyTokens = new Map([['pid','<PID>'],['pgid','<PGID>'],['jobId','<JOB_ID>'],['sessionId','<SESSION_ID>'],['artifactId','<ARTIFACT_ID>'],['receiptId','<RECEIPT_ID>'],['requestId','<REQUEST_ID>'],['nonce','<NONCE>'],['signature','<SIGNATURE>'],['hostname','<HOSTNAME>'],['machineIdSha256','<MACHINE_ID>'],['streamHandle','<STREAM_HANDLE>'],['releasePath','<RELEASE_PATH>']]);
export function normalizeDynamic(value, key='') {
  if(dynamicKeys.has(key)) return keyTokens.get(key) ?? '<TIMESTAMP>';
  if(Array.isArray(value)) return value.map((entry)=>normalizeDynamic(entry));
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map((child)=>[child,normalizeDynamic(value[child],child)]));
  if(typeof value==='string') return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu,'<UUID>')
    .replace(/\/tmp\/[A-Za-z0-9._/-]+/gu,'<TMP_PATH>')
    .replace(/\/opt\/se-z\/releases\/[A-Za-z0-9._-]+/gu,'<RELEASE_PATH>');
  return value;
}
