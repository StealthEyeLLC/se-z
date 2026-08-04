import path from 'node:path';
import fs from 'node:fs';
import {GatewayState} from '../phase3/atomic-state.mjs';
import {GithubAuthority,MemoryGithubIntentState} from '../phase3/github-authority.mjs';
import {ReleaseController,RecoveryUnavailable} from '../phase3/release-control.mjs';
import {SezError} from './util.mjs';

export class Phase3SupervisorControlPlane {
  constructor(config,{githubAuthority=null,fencingAuthority=null,gatewayState=null,releaseController=null}={}) {
    this.config=config;
    this.github=githubAuthority;
    this.gatewayState=gatewayState ?? new GatewayState(config.phase3GatewayStateRoot ?? '/var/lib/se-z-gateway');
    this.release=releaseController ?? new ReleaseController({
      root: config.phase3ReleaseStateRoot ?? path.join(config.stateRoot,'phase3-releases'),
      fencingAuthority: fencingAuthority ?? new RecoveryUnavailable(),
      gatewayState:this.gatewayState,
    });
  }
  static fromEnvironment(config) {
    let github=null;
    const appId=process.env.SEZ_GITHUB_APP_ID;
    const installationId=process.env.SEZ_GITHUB_INSTALLATION_ID;
    const privateKeyPath=process.env.SEZ_GITHUB_APP_PRIVATE_KEY_FILE;
    if(appId&&installationId&&privateKeyPath) {
      github=new GithubAuthority({appId:Number(appId),installationId:Number(installationId),privateKey:fs.readFileSync(privateKeyPath,'utf8'),state:new MemoryGithubIntentState()});
    }
    return new Phase3SupervisorControlPlane(config,{githubAuthority:github});
  }
  requireGithub(){if(!this.github)throw new SezError('github_app_unavailable','GitHub App authority credential is unavailable');return this.github;}
  async execute(operation,payload) {
    switch(operation) {
      case 'sez.github.app.verify': return this.requireGithub().verify(payload.repository);
      case 'sez.github.api': return this.requireGithub().api(payload);
      case 'sez.github.git': return this.requireGithub().git(payload);
      case 'sez.github.reconcile': return this.requireGithub().reconcile(payload.intentId,async intent=>payload.readback ?? {ambiguous:true,intent});
      case 'sez.release.status': return this.release.status(payload.deploymentId);
      case 'sez.release.build': return this.release.build(payload);
      case 'sez.release.stage': return this.release.stage(payload.deploymentId);
      case 'sez.release.verify': return this.release.verify(payload.deploymentId,payload.checks ?? {});
      case 'sez.release.activate': return this.release.activate(payload.deploymentId,{accept:async()=>Boolean(payload.acceptancePassed),responseLoss:Boolean(payload.injectResponseLoss)});
      case 'sez.release.rollback': return this.release.rollback(payload.deploymentId,payload.reason ?? 'owner requested rollback');
      case 'sez.release.repair': return this.release.repair(payload.deploymentId);
      default: throw new SezError('unknown_operation',`Unknown Phase 3 operation: ${operation}`);
    }
  }
}
