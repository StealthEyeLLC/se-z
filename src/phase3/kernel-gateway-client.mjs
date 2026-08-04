import {SezClient} from '../kernel/client.mjs';
import {loadPublicKeys,verifyReceipt} from '../kernel/crypto.mjs';
export class KernelGatewayClient{
  constructor({socketPath='/run/se-z/gateway.sock',gatewayId,gatewayKeyId,privateKeyPath,receiptVerificationKeys,clientId='se-z-gateway'}){this.socketPath=socketPath;this.gatewayId=gatewayId;this.gatewayKeyId=gatewayKeyId;this.privateKeyPath=privateKeyPath;this.receiptVerificationKeys=receiptVerificationKeys;this.clientId=clientId;this.client=null;this.keys=null;}
  async initialize(){this.client=await SezClient.gateway({socketPath:this.socketPath,gatewayId:this.gatewayId,gatewayKeyId:this.gatewayKeyId,privateKeyPath:this.privateKeyPath,clientId:this.clientId});this.keys=await loadPublicKeys(this.receiptVerificationKeys);return this;}
  async call({operation,payload,idempotencyKey}){if(!this.client)await this.initialize();const {request,response}=await this.client.call(operation,payload,{idempotencyKey});if(response.requestId!==request.requestId||response.operation!==request.operation||response.catalogDigest===undefined)throw new Error('gateway_receipt_invalid');const checked=verifyReceipt(response.receipt,this.keys);if(!checked.valid)throw new Error('gateway_receipt_invalid');return{...response,receiptVerified:true};}
}
