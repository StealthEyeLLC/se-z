# Phase 1 Source Inventory

Generated from the exact pinned trees. **230 tracked files** are inventoried; every file copied later must resolve to one of these SHA-256 records.

## Component counts

| Component family | Files |
|---|---:|
| artifacts | 2 |
| Caddy | 3 |
| canonical encoding | 3 |
| CLI | 5 |
| configuration | 5 |
| documentation | 17 |
| files | 4 |
| GitHub authority | 10 |
| idempotency | 1 |
| jobs | 3 |
| MCP gateway | 7 |
| native addon | 2 |
| OAuth | 2 |
| operation registry | 5 |
| packaging | 39 |
| peer authorization | 3 |
| protocol | 4 |
| PTY | 2 |
| raw execution | 2 |
| receipts | 3 |
| recovery source mechanics | 1 |
| release lifecycle | 39 |
| replay | 1 |
| request authentication | 3 |
| self-hosting | 17 |
| signatures and keys | 2 |
| skills | 10 |
| state storage | 4 |
| systemd | 7 |
| tests | 24 |

## Complete file inventory

| Source | Path | SHA-256 | Language | Family | Destination | Status |
|---|---|---|---|---|---|---|
| StealthEyeLLC/baby-quirt | `.env.example` | `c4b6a2e98e27ebb50ffbcb36891bcce285f65d37d726ffe3f85a38c362858f28` | configuration example | configuration | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `.github/workflows/bootstrap-nspawn-host.yml` | `2d0e357cd010a0baec619a91e7de419eb1744ca9a831bd35fbfb0508b770b59d` | YAML | GitHub authority | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `.github/workflows/ci.yml` | `dfe7ef4c1e38dc68fd834d1c4f66310554a6d25a75fcd9bb9536c62765d4f822` | YAML | GitHub authority | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `.gitignore` | `bbe89ab0492463be50757497362fd656c1ae92c8127ad1345e41ee1fb736e374` | text | packaging | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/auth.test.ts` | `180ed8acf5e45ccc74068d473921c7855f5ea8f8806c02829926b31e037f469e` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/cancellation.test.ts` | `3418fb06c5756a02ceb51e07053ddce1550a70d9df30d11463b151e60f83decd` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/deployment.test.ts` | `5a01fa4553ccf5637d59faf47ea66cbd7032e2b96b6fa43ee9107eca0a611672` | TypeScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/filesystem.test.ts` | `268e9571fb716b602200cc6289364a455f740f0f2052811b194e447569e5e7f1` | TypeScript | files | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/fixtures/local-fixture-pkg/index.js` | `6d25aaa55e6743a689353d831d7062b3f8f829802ec810ddee67a0d1b55041fc` | JavaScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/fixtures/local-fixture-pkg/package.json` | `e793b484859a70eb5d9e067dc1ecb283a250300d09aa64b5469f91eb5f20d2df` | JSON | packaging | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/helpers/protocol.ts` | `84aba20e1e82743cdcbffdf6deadae3835e98ce69bfb14e8c3143aebb4978c8d` | TypeScript | protocol | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/jobs.test.ts` | `6563d82daf410ca6b5c6aefa23805cade04ac113eea56aa1956707f5773620c6` | TypeScript | jobs | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/process-identity.test.ts` | `3a6a5a0eac2d152576a94d8cb259b850a62fe58e4d4fadf9d76ce5b96e3002bd` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/pty.test.ts` | `cee904304f242c7e914b7e8e556a4c812111fbd3dbd8f59fd8ecb7402e3d2f55` | TypeScript | PTY | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/release.test.ts` | `57ce882e2d8dcd7a7cc41ac9925f4a05a79b2f138449f1647800c99e52fb827c` | TypeScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/restart.test.ts` | `4ccd7dde88dfb5d598df307173dd938e7e882452d74fed7ee7c5653589ddfb95` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/secret-redaction.test.ts` | `b3f33a955887f31679035e9b472bc32cdadb31eaaca4a7548f8206d6512142cd` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/self-hosting-full.test.ts` | `cd5edd86bfebc4352dfc4f8927352dec5417beeec2f9ab15ea159167f5cc11b5` | TypeScript | self-hosting | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/self-hosting.test.ts` | `53b79eec90151b3e730265d2723198b3032c5b17f6458e509d5a7c51ba870664` | TypeScript | self-hosting | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `acceptance/systemd.test.ts` | `b630166ec1750479d9e5877cacb2a280fae722d72d0c641badbe296017fb5aff` | TypeScript | systemd | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `binding.gyp` | `1f678d06211023db6759148542e98faba5fbbcb28dd27ec43ba2878531ace45c` | GYP | native addon | `src/native/peercred/binding.gyp` | PLANNED |
| StealthEyeLLC/baby-quirt | `contracts/baby-quirt-contracts-v1.json` | `d14b66f8544583007c06629ce0fde3f23d3ca5302592a3c506fd3c26364d3954` | JSON | packaging | `test/parity/fixtures/source-contracts/supervisor/contracts/baby-quirt-contracts-v1.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `docs/ARCHITECTURE.md` | `20d14946a0463daef150a7a1cea5021185e931169176e80182b4ac0b4ef3c056` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `docs/FAILURE_RISK_EVIDENCE_INDEX_V2.md` | `8cacf7d698f3526eda8c52baae8c7ebf88d972e5069cd6b2ebeff5fe0e744e23` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `docs/FAILURE_RISK_REGISTER_V2.md` | `2f8cacff3012c88c774399a30226a2aa3896da217294194a74d76991f6f68466` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `docs/PRODUCTION.md` | `dc5e019b7d0b313adf2ab5f635617bcd80494a2acf330e2251c5a3260ee1bb13` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `docs/READINESS_V2.md` | `97d1c6af89eddb168e3ba1468ea27b15023196d7c9ffae2fce3e6c211d1feefc` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `docs/RUNBOOK.md` | `72841c4768f6fca58b5b493e990307ac7ab6088273d43bc1d668dbbc0e2dd9b3` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `docs/SECURITY.md` | `0c5a422647d3ade739c536ef54a37ff00e30bc3d97d4ba2e5d6e9ea89e7adae8` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `docs/STANDALONE_DEPLOYMENT_V2.md` | `232aba7d7c05fa70980631dac799f0972bdc0c84b912d2601948dedc7e653367` | Markdown | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `docs/USING_WITH_CHATGPT.md` | `17df9ee48f3ea0bd661393b35e0f2b511f4280c51ca03e66a4a52e9d94804847` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `examples/skills/proof-echo/index.mjs` | `0511aa20a9970531d940dcda54eaa6e880f67aec90b2d7c0f88bb5043cfa906d` | JavaScript | skills | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `examples/skills/proof-echo/skill.json` | `3173eb32a77ef4e88cddc2594ce157015a63a618521fed52fe255399ad5a0ef9` | JSON | skills | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `integration/server.test.ts` | `c2e587f3976ff888339cb4ebe332ad3491cf006e8b9761c5acd50974d32f26ce` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `native/src/peer_cred.cc` | `261da5163bd0a18c38c941f9685e9b5fde889c59b87ee7f14bd9f7e7c6f7e305` | C++ | native addon | `src/native/peercred/src/peer_cred.cc` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/bootstrap/baby-quirt-ci-deploy.pub` | `8a75242d326ee652b5474792e8c6556b5481abff90feeb247eb3db6e7be144ca` | public key | packaging | `packaging/bootstrap/se-z-ci-deploy.pub` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/bootstrap/gateway-authority-public.pem` | `0288179e795a801111cebfbba1b43fd3792f08b38c861974eff4a915d61b1ed7` | PEM public material | packaging | `packaging/bootstrap/gateway-authority-public.pem` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/bootstrap/README.md` | `d5d8a943a36941a140befc76a6c30be63ae07b8cd1a55813ad3d1017a236cb90` | Markdown | documentation | `packaging/bootstrap/README.md` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/controller/bin/baby-quirt-deploy-guard` | `ff5aeebc269924e7bf9721a01d498242cc7a6423539b58d3c4829dc0d8f77653` | text | self-hosting | `packaging/controller/bin/se-z-deploy-guard` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/controller/README.md` | `d2e7e4b39e711a6c7d8c9812d73c2d45ab1b7c780e534914d1935da46265673d` | Markdown | self-hosting | `packaging/controller/README.md` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/rehearsal/baby-quirt-host-certification.mjs` | `592ccb87f884370bdee5b86587e7797be6d404066c1362fdfb603421ac89426f` | JavaScript | packaging | `packaging/rehearsal/se-z-host-certification.mjs` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/rehearsal/baby-quirt-host-certification.service` | `89979ed5d8db3bfae53bbe53c7fe9bedceb188f5a7a5b8fa1a9bcac633ddcc1e` | systemd unit | systemd | `packaging/rehearsal/se-z-host-certification.service` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/rehearsal/baby-quirt-nspawn-runner` | `58a121ba2a403132a3bc875b895d6ae2c40bbfe439ae88e49f4005c61f2c5f42` | text | packaging | `packaging/rehearsal/se-z-nspawn-runner` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/rehearsal/baby-quirt-peer-cred-probe.py` | `0a619dfc3eac125e45908dba74f61f1ea9bab3a675a735915ef48a126f355737` | Python | peer authorization | `packaging/rehearsal/se-z-peer-cred-probe.py` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/rehearsal/bootstrap-nspawn-host.sh` | `eb46d2e59d2b7ffd7e8f392d85efbba4f86b60411166dcfec68d661c44fb9491` | Shell | packaging | `packaging/rehearsal/bootstrap-nspawn-host.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/systemd/baby-quirt-deploy-guard@.service` | `22569e47b22aa2732af223d4ddb98a7165ea746a33029c1eed19958b07af799e` | systemd unit | systemd | `packaging/systemd/se-z-deploy-guard@.service` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/systemd/baby-quirt-deploy-guard@.timer` | `9260fd089e1fb8918bbb5d26069588648ef456397fc14f21f5a7e16a53c31f06` | systemd unit | systemd | `packaging/systemd/se-z-deploy-guard@.timer` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/systemd/baby-quirt.service` | `2e7f6c1ab7493009e1e5db747e85264726ae4d196d0cbe5af2a0328cd2ba8bef` | systemd unit | systemd | `packaging/systemd/se-z.service` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/systemd/baby-quirt.socket` | `6fdc80aad23f28e209ea0096f20c008beda4c8f9871790ad971a0b5814e616bb` | systemd unit | systemd | `packaging/systemd/se-z.socket` | PLANNED |
| StealthEyeLLC/baby-quirt | `ops/tmpfiles/baby-quirt.conf` | `5af50820c8a5dca43c2182ee9ec29deb9cdcb5de6e6e49749d01eb253280d721` | configuration | packaging | `packaging/tmpfiles/se-z.conf` | PLANNED |
| StealthEyeLLC/baby-quirt | `package-lock.json` | `9d3eeaee1e96e3c5d4567c7fa46ecd821691deb3ec88f030c0616ce0043eca9e` | JSON | packaging | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `package.json` | `16af42e0570449c27605ddb4bb637c2786117bcc82f28300a57cc8378206919b` | JSON | packaging | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `README.md` | `e432527191ae5f2171f201f14cb67ddb9a34733b78198f663f62a96c2fddf745` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `schemas/baby-quirt-protocol-v1.schema.json` | `224f0bcefee71221c2a8b205e1d0002639834aa61e9c22ce25dfdfd905f2ad97` | JSON | protocol | `test/parity/fixtures/source-contracts/supervisor/schemas/baby-quirt-protocol-v1.schema.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `schemas/deployment-v2/compatibility-declaration.schema.json` | `57d224996a51433fb868e171773d8b9b603b1ffcdb749364880039019c346b2c` | JSON | release lifecycle | `test/parity/fixtures/source-contracts/supervisor/schemas/deployment-v2/compatibility-declaration.schema.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `schemas/deployment-v2/deployment-evidence.schema.json` | `3e3dfac718a92d6285596772bfa5ad8a9d740de9a2d384b27cf270b2953d98ee` | JSON | release lifecycle | `test/parity/fixtures/source-contracts/supervisor/schemas/deployment-v2/deployment-evidence.schema.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `schemas/deployment-v2/deployment-request.schema.json` | `84a00bc2daae326501a266d452293cddf648daf6e50289e2ca475d86a5fb8789` | JSON | release lifecycle | `test/parity/fixtures/source-contracts/supervisor/schemas/deployment-v2/deployment-request.schema.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `schemas/deployment-v2/deployment-state.schema.json` | `5e7f89b0bc763f3c264f57716c4b4e2fb1c2179cddd58ceaa9519da2d39b34f2` | JSON | release lifecycle | `test/parity/fixtures/source-contracts/supervisor/schemas/deployment-v2/deployment-state.schema.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `schemas/deployment-v2/release-manifest.schema.json` | `31b3ab47ec1ec360c60cee98d37cd991e83c045a76408d86fb603fcb5b1e90b6` | JSON | release lifecycle | `test/parity/fixtures/source-contracts/supervisor/schemas/deployment-v2/release-manifest.schema.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `schemas/deployment-v2/rollback-snapshot.schema.json` | `3165d284415232a9b02c5ee185ed7434cdfd3065e708359a45ca4d8c91e37997` | JSON | release lifecycle | `test/parity/fixtures/source-contracts/supervisor/schemas/deployment-v2/rollback-snapshot.schema.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `schemas/deployment-v2/success-marker.schema.json` | `790fe59bada041ad8dc444574ca4797acd17bed4fad600af7b31efcfedc87e00` | JSON | release lifecycle | `test/parity/fixtures/source-contracts/supervisor/schemas/deployment-v2/success-marker.schema.json` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/bootstrap-safe-extract.py` | `baa583b10602efb1205a74d668a513d4182ed754d2b5c36f15e7a4846126b640` | Python | packaging | `scripts/extracted/supervisor/bootstrap-safe-extract.py` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/build-bundle.sh` | `8e1d7ad81f3a74fe07dbf669309a4bc5c7b1bd1627c2001b68651c659f93a1e7` | Shell | packaging | `scripts/extracted/supervisor/build-bundle.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/build-controller-bundle.sh` | `854d228fec16033377a5524ae3ac9199ddb381ec5010927750d265badf03c482` | Shell | self-hosting | `scripts/extracted/supervisor/build-controller-bundle.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/build-release.sh` | `ba674d5f7af0e59e348679bcd5b04a8e1dd3b789f417ea900141a57073523813` | Shell | release lifecycle | `scripts/extracted/supervisor/build-release.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/build.sh` | `c2f7b044a89947db6b11d7a90c9d4c761fea6963cb9faf11dc7d6109ad416c30` | Shell | packaging | `scripts/extracted/supervisor/build.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/configure-github.sh` | `9159c9ed06a919d6a3e7b49a8f84c1c3a2715161220dc3291ae513fa334eac67` | Shell | GitHub authority | `scripts/extracted/supervisor/configure-github.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/create-package-spec.ts` | `11af0809a85875c563171675d7eea6f01537d72b50a11c4aea59fd74fa3a4cc4` | TypeScript | packaging | `scripts/extracted/supervisor/create-package-spec.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/finalize-release.ts` | `951358f31f83b845d4a6f5d855b0daf798a71e061665c519d0632245a3f9e849` | TypeScript | release lifecycle | `scripts/extracted/supervisor/finalize-release.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/package-controller.ts` | `f7f6897f4ff6e43b5b7781f1c8715fe96d006737e7235ac6ca64fa4932468be9` | TypeScript | self-hosting | `scripts/extracted/supervisor/package-controller.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/package-release.ts` | `0ce5ce48ed61b3b76d550b7439bf41236f5a68a90757c7d1f03d7ee185fd4276` | TypeScript | release lifecycle | `scripts/extracted/supervisor/package-release.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/prepare-nspawn-input.ts` | `1f00e92c6236f024b3170ba928ddf8e7f2c08c5a5f086c96cada0059de0f200d` | TypeScript | packaging | `scripts/extracted/supervisor/prepare-nspawn-input.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/release.sh` | `815d6bb8be14fbd4938facf4b82dd0e64691f51abab0c90677823686d2f0168a` | Shell | release lifecycle | `scripts/extracted/supervisor/release.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/remote-install.sh` | `8ef76e5bb750c6d2a8f09c760d11c49158357c955a1927dcadfbb3df5362cf65` | Shell | packaging | `scripts/extracted/supervisor/remote-install.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/remote-rollback.sh` | `3248b2d468e97533efc15f7a502590c11face97534dfe16a498908f94e6906bd` | Shell | release lifecycle | `scripts/extracted/supervisor/remote-rollback.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/validate-contracts.ts` | `d10a2b56ff8222b6cd376ef29a3afcc85db79aafbbc22a0ac232386c86ce10b5` | TypeScript | packaging | `scripts/extracted/supervisor/validate-contracts.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/verify-candidate.ts` | `96bc0b2c2327d6117c9a9d62bbb931096a376cb34bb09494ce756a52019106b0` | TypeScript | packaging | `scripts/extracted/supervisor/verify-candidate.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/verify-controller-candidate.ts` | `b981808e670cdf14bdd4c9e834f4cd075e42c50cf55e30160637d2c6be93ef8c` | TypeScript | self-hosting | `scripts/extracted/supervisor/verify-controller-candidate.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `scripts/verify-runtime-deps.sh` | `cb6ab6beaa08d4c5d0faa6d252eeb2540d39bd448799f76005bd8815fa17dc55` | Shell | packaging | `scripts/extracted/supervisor/verify-runtime-deps.sh` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/artifacts/manager.ts` | `6de378fabe995baf40c4dd998f8e7a1a07372c525dabfdf4773fc06584ebdd98` | TypeScript | artifacts | `src/artifacts/manager.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/auth/authenticator.ts` | `c9dfd59a04c012a8ef1c56b55d4c08b68325f59b7a19c6ba656e8b5a085c9097` | TypeScript | request authentication | `src/supervisor/dispatch/auth/authenticator.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/auth/errors.ts` | `ad5c23191d39da3bc01d2af7e02c3cac0c73fa5a395ab51d5540ccd7a0224ae2` | TypeScript | request authentication | `src/supervisor/dispatch/auth/errors.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/auth/principal.ts` | `4556f73426348a70b996ce9bfd9aae96b2c87cef73c0dc72f9202c89d6700c35` | TypeScript | request authentication | `src/supervisor/dispatch/auth/principal.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/cli/install.ts` | `b8eea17082ad34960d45dd27245717eb5c486c4d958da563764cdd52ead188c4` | TypeScript | CLI | `src/supervisor/cli/install.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/cli/main.ts` | `5514c2976f3ba420afe5dd4218eb4d0d9a70f5453394b2ff5876f89083164caa` | TypeScript | CLI | `src/supervisor/cli/main.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/cli/repair.ts` | `cd955ee986fbc3982b14015bd181b6c8b6c44244593d2afb0e0475005f17dd0f` | TypeScript | recovery source mechanics | `src/supervisor/cli/repair.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/cli/rollback.ts` | `6048d159529cd4ac9c877324ed3b0acd7175b8c467e828f34db2a90c87f548a8` | TypeScript | release lifecycle | `src/supervisor/cli/rollback.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/cli/verify.ts` | `5bae7197ad66ef3867c9dd6333ee1a4a281dcfa560a7eb5e073f65e98b0126b7` | TypeScript | CLI | `src/supervisor/cli/verify.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/config.ts` | `956248b8faadb9a5eebf33199fde430549ccce05f1a09761dcee8db20f53775f` | TypeScript | configuration | `src/supervisor/configuration/config.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/bootstrap.ts` | `48feef2bd837315e3b555563860b5682e6b712df5d6236e928565e4ca0a2cca1` | TypeScript | self-hosting | `src/selfhost/controller/bootstrap.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/cli.ts` | `9e2cdee9abe7d7dd697846a7a72ecb48e3d52e3ed37bf2ea8b114e026fde4ad5` | TypeScript | self-hosting | `src/selfhost/controller/cli.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/contract.ts` | `142985983d27d1617cbefb3cdd88118feee3920d8e6b0f6345e4d1d780dca625` | TypeScript | self-hosting | `src/selfhost/controller/contract.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/controller.ts` | `2e0b50c1cba966ba623bd7ca6a065d8f65e7e770c59b204348cc9d5215a9de73` | TypeScript | self-hosting | `src/selfhost/controller/controller.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/filesystem-host.ts` | `e44f28905ce1197bcb93139d8d60465f12b45db76bd319f3527fef6f4e17a026` | TypeScript | files | `src/selfhost/controller/filesystem-host.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/fixture-host.ts` | `f0a72229562a4debfc287c8633052bb1b7c0eb9bef05cee0429d73dbfa0cfea8` | TypeScript | self-hosting | `src/selfhost/controller/fixture-host.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/package.ts` | `725bc0911f2b656897f614abac6c81dd29213e2e1f9341e626b4e6537d2dd3f0` | TypeScript | self-hosting | `src/selfhost/controller/package.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/storage.ts` | `7442b08b9df3342ce12bf48e2ee0132d2eee85e74cb95e0a7b4054acc0181015` | TypeScript | self-hosting | `src/selfhost/controller/storage.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/controller/types.ts` | `6b15325dd65d99cc1304281028d107c184b4ec13aef515575833c3b9a65a6b59` | TypeScript | self-hosting | `src/selfhost/controller/types.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/crypto/canonical.ts` | `415b4a9ed737a508d5364438514024ec8a548f7f9835f3aa7920c8f9529ea6f6` | TypeScript | canonical encoding | `src/protocol/canonical/canonical.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/crypto/signing.ts` | `ea0f2766f953aa5f2984737b4a99d810e1a646894543a2c16d7972fc2e14ce4b` | TypeScript | signatures and keys | `src/protocol/signatures/signing.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/deployment/activation.ts` | `8d79e31d2e436c48df0a0f7d6b8eb4cb688b615b21a2606883783440bad665e2` | TypeScript | release lifecycle | `src/releases/deployment/activation.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/deployment/database.ts` | `f083552770e7fe99a3ad2241e949282107da8186f99f879e0ea97e23928e0a41` | TypeScript | state storage | `src/releases/deployment/database.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/deployment/inactive-install.ts` | `8cdb7c70d46a72de9c5957b613dfd7fc2ba8b52fd35e99b97d4c6bd0ec652afa` | TypeScript | release lifecycle | `src/releases/deployment/inactive-install.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/deployment/permissions.ts` | `c6457786d2831e640b17215194580e2cfb3dfcb319a135dd6c255113a887a58d` | TypeScript | release lifecycle | `src/releases/deployment/permissions.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/deployment/service.ts` | `b4bfe9ed087a575459961820d51146f3b2091d3705f0aea62c2ee048cd4dbe24` | TypeScript | release lifecycle | `src/releases/deployment/service.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/deployment/snapshot.ts` | `2a05eded8628660325f9bec974b3e83c1550328586a57edcd14e7eb23fbe18ea` | TypeScript | release lifecycle | `src/releases/deployment/snapshot.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/deployment/state-machine.ts` | `9cd94a10ee729b3ef6142090acd928ae3601b39c9c6996e3aa5b80c8159a5508` | TypeScript | release lifecycle | `src/releases/deployment/state-machine.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/deployment/types.ts` | `8c0f0d99d5b598e5f89328b03753b02eec1c67405cce348a5955a5db21e56f0b` | TypeScript | release lifecycle | `src/releases/deployment/types.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/files/manager.ts` | `d38acc332125505faa552154bdd1c30b39e688e6c9db6ce386e5f7854a59bfbe` | TypeScript | files | `src/files/manager.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/github/app-authority.ts` | `10d5a3f388453fabe4720f4eb972c173a09d684849cb9b64b174b3ce8ce810c6` | TypeScript | GitHub authority | `src/github/app-authority.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/index.ts` | `6a444d5452ff15fa2480c4c162be3a3f042b0efe31b98d0419635b21afd97970` | TypeScript | packaging | `src/supervisor/server/index.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/install/safe-extract.ts` | `1244f208051b41aed67d3e9400c2f14301a7a05a477068f0591f41afa025679f` | TypeScript | packaging | `src/selfhost/install/safe-extract.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/install/symlinks.ts` | `13e50fea9173b97109dc3222817f1a071e1eb40201e62604c7fbbb083f28eda3` | TypeScript | packaging | `src/selfhost/install/symlinks.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/jobs/manager.ts` | `364e14082eadb71c6d83bf0c6d398797fafbb26ca32b2c52162bd1b44a5ec746` | TypeScript | jobs | `src/jobs/manager.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/net/peer-cred.ts` | `24060be231215225ab6e20b8bb36212ae89fbbdc6883dbcfde1680178e4e2bee` | TypeScript | peer authorization | `src/supervisor/peers/peer-cred.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/net/socket-activation.ts` | `d55305893071468eb3c6999877d2474d35bb7a71a1b1c11bae8a64258e5a45f7` | TypeScript | packaging | `src/supervisor/sockets/socket-activation.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/operations/definitions.ts` | `222d4f0916eb26d62a8c6c1e586da514295549386159129dbde38ed53d420e09` | TypeScript | operation registry | `src/operations/definitions.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/operations/errors.ts` | `9d1c5f59b16649e3f0637ef7149ce77599f456abf554916ef070c38d81606682` | TypeScript | operation registry | `src/operations/errors.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/operations/registry.ts` | `1c0eddf79c2cdc1cd9ffdaa1a5ad0c77836df86324a389a906282b4bab23a1f9` | TypeScript | operation registry | `src/operations/registry.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/process/identity.ts` | `962d6f1f0d685814f7ef6b3521c00ec59f79a084a4955953d00481f84a18f45d` | TypeScript | raw execution | `src/execution/process/identity.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/protocol/frame.ts` | `f6e17591dc514d927350d09307e67904bbded5486bddc2becd83a02c5c82d3d1` | TypeScript | protocol | `src/protocol/framing/frame.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/pty/manager.ts` | `11e25f17e6a0ae9ceaa6734aa3c3986dff797b9fff684eb18e6fad8e47414dfb` | TypeScript | PTY | `src/pty/manager.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/receipts/receipt.ts` | `cabf8bf062a55ff08757d8bdfcc365a4b5fb297285b044585eb1f61a2f9e6973` | TypeScript | receipts | `src/protocol/receipts/receipt.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/receipts/verify.ts` | `e61b9cac7e025b61e0901db188cd95967f6e6819d7a3dfb9f35f338bc9411d21` | TypeScript | receipts | `src/protocol/receipts/verify.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/rehearsal/nspawn-cli.ts` | `7f33181b1d48c08b76be833ed0ca98df69289d31e4fe15adda1550661abc03f2` | TypeScript | packaging | `src/releases/rehearsal/nspawn-cli.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/rehearsal/nspawn-contract.ts` | `20abf38baab517f36b54e42fbb21cebabc437f068ded705e91225531ee67dab9` | TypeScript | packaging | `src/releases/rehearsal/nspawn-contract.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/rehearsal/nspawn-executor.ts` | `664e136b2747cdf6e8938b8939ee04cc755f41b1e0680604f3499eeb00e9cc7a` | TypeScript | raw execution | `src/releases/rehearsal/nspawn-executor.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/rehearsal/nspawn-input.ts` | `f5374ac718308ed81a39e6f8b8d2fa60d3cc889d94deef7451b1bf946f0c738a` | TypeScript | packaging | `src/releases/rehearsal/nspawn-input.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/rehearsal/nspawn-runner.ts` | `777aece3c0bd9a9d438d9b27f0c08acaabde21b3602c8f2dd05324dedbae6124` | TypeScript | packaging | `src/releases/rehearsal/nspawn-runner.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/release/archive-contract.ts` | `49dbd8a050eb51e34e333d88ffff2a7f78939d749c5cf4e613f30974c029d622` | TypeScript | release lifecycle | `src/releases/archive-contract.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/release/deterministic-archive.ts` | `8f2357dec71e478bfc63132658967f19fc8b7746c79054c06be213bdf2fd0825` | TypeScript | release lifecycle | `src/releases/deterministic-archive.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/release/package-release.ts` | `88afe949bb882794421324367809ce60b0feb8c0f8985ea6fca45bfd50be108a` | TypeScript | release lifecycle | `src/releases/package-release.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/release/release-manifest.ts` | `cce36ff74eba971f180a7073109e8f5acd4af7a5512ab7b892b0322a204b7077` | TypeScript | release lifecycle | `src/releases/release-manifest.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/release/strict-extractor.ts` | `6d13d2e11fe3c7c69a98c96226c4d100432a68fbe58c0da767614f356e678618` | TypeScript | release lifecycle | `src/releases/strict-extractor.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/secrets/provider.ts` | `374b26ab3b0201e165b75f8921c1d95ecb292f492c8a28e0213720c75d201ba8` | TypeScript | packaging | `src/supervisor/configuration/credentials/provider.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/server.ts` | `a00f60c9342268bb1d786942936fb2c6fb9204893fca2cf894d05ecc321e5af5` | TypeScript | packaging | `src/supervisor/server/server.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/skills/activate-cli.ts` | `5d3c8e66fda848c9454ac1a1fab036c1ad9435201cd0c20f554a6fc9d6ca239b` | TypeScript | skills | `src/skills/activate-cli.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/skills/activation.ts` | `67965a0fc39200f43ed1836eb29af2cfcc40fa14b9174d351574a62e9a722056` | TypeScript | skills | `src/skills/activation.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/skills/loader.ts` | `2c36a0194fcf30292397227ea0a67524e4ab89d87a1ac6f701934f7bfed8a990` | TypeScript | skills | `src/skills/loader.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/skills/preload-cli.ts` | `043026d2e57804820b7c926e89099569eaf6903fab4924b12522664bccc8b13b` | TypeScript | skills | `src/skills/preload-cli.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/skills/schema.ts` | `23da9a103586b5fbae369d3b36214d3ffbef17540554fab948549897c60d6076` | TypeScript | skills | `src/skills/schema.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/skills/service.ts` | `08d44abeee8fc4fc5a24fc1df06ea385de5bfea7185f26d7bf55e772891891b9` | TypeScript | skills | `src/skills/service.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/skills/types.ts` | `d71cef527abee07da3ca313bec67c4793d928cf73865f2192330a3ed9da41635` | TypeScript | skills | `src/skills/types.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/state/replay-store.ts` | `f63787dc8f6df7d76f17f21bdb4a5037650bd9541e3e7702dbfe4aa53e003cf3` | TypeScript | replay | `src/state/replay/store.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `src/state/store.ts` | `6ced92cc63d55f16186a29d826c6655db8639a6a0d7dcf09549ac266f18f8975` | TypeScript | state storage | `src/state/store/store.ts` | PLANNED |
| StealthEyeLLC/baby-quirt | `test/artifacts.test.ts` | `a32aa0422fcf190ab0dddf9db0a4b55d1b5311465268aaac2fce8bd5ba1fb86d` | TypeScript | artifacts | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/bootstrap-safe-extract.test.ts` | `b0e7fe18ce5db0209639cc9d5213ebf8681fa3d8dfcaeb755eb0661486a08ea0` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/canonical.test.ts` | `861084c152a8fa690a00f2c488873b2a57c5ec4301f947c907511e5f54d1da1e` | TypeScript | canonical encoding | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/controller-bootstrap.test.ts` | `c4b5057fc608ec15e56b6e1c6b128dd1dae98e33176d48827c094a36ae559c78` | TypeScript | self-hosting | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/controller-guard.test.ts` | `7cec19e2f5ae3ece7285ee9226344d96476fbc029e0769da1f4deb82ffe9e8b5` | TypeScript | self-hosting | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/deployment-database.test.ts` | `fce13e7d68e1c585b91fb6ce58ee77964e0cd456f22023ecf19fea691298e563` | TypeScript | state storage | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/deployment-lane.test.ts` | `59f0535a1de512984913913d66e0510a1e11eaf0be4263ba4c6727c21d49f7a4` | TypeScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/deployment-operations.test.ts` | `c68cb195aee6980261eca0f9792f5c17b9ce2738daa2c8d82a97935607232b9c` | TypeScript | operation registry | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/deployment-schemas.test.ts` | `49f8ba5059e489ad20f1f9519d107c4c0da4d0ea451f7f21e5bd53de1a7a3c71` | TypeScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/deployment-state-machine-v2.test.ts` | `f0e490852cd881e024a402034c953717e4859c1484bbbb099fee4a951dfe8625` | TypeScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/files.test.ts` | `6014988fcf6beed2cf1aa23ffb4c3335e64600cc36cfd504d08688eda9676b1a` | TypeScript | files | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/frame.test.ts` | `0adb69bf03c7cbadcd669f7b80c56fe5409208206c0ff39a01ab76e5bdd94016` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/github-app-authority.test.ts` | `70a22c1ea64158a16d7873724e56fba48d2eac1713053fb9a09706bdfe3de00f` | TypeScript | GitHub authority | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/helpers/client.ts` | `73bf75d08da25e3d70460f2c00360e49438190349e4a215edaaca12be8510c42` | TypeScript | CLI | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/helpers/server.ts` | `2a01f1eb7cc4b85749492c4b98c41f24fffa1355f95eaad3c8913e4fc4e1178d` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/idempotency.test.ts` | `7f0fbb917ce30b79b9b4e107f1f2295dcc467e2584bf795f1e525b46bcbf2506` | TypeScript | idempotency | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/inactive-install.test.ts` | `301197619856e25888ecd1dcb7be6ff46b3f5ed26621c8980d4a5c24b5a509a6` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/jobs.test.ts` | `857c88fe567c1ca0688cd9193fe7e34f4be6d14e06fe5fc28ab82727800511ce` | TypeScript | jobs | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/machine-id.test.ts` | `ab87e6d728d2cd303b6c6999c3cbce52588f9a7d1b237510ef68b809151c9d67` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/nspawn-bootstrap.test.ts` | `3874c532903f76142dfd37bcdc99e69939b11d9fda876a82e4e07271504de530` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/nspawn-input.test.ts` | `b504f778bda5414fd89b79565de52111d0bbb819c0b899c480dcf58b23be7131` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/nspawn-rehearsal.test.ts` | `a1aec24ee7ad05b0c42cf06ead430376897f0204388df0ddbac03c7de6a79446` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/operations-discovery.test.ts` | `7883e677b103fc6b28d54873a05301ac6a2e7eeccb6b4f69001d042ff308d577` | TypeScript | operation registry | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/peer-cred.test.ts` | `a768a24ee4ee91f5ff325a2f52401c2b7fabc300f1375000401ef29e9ef017d0` | TypeScript | peer authorization | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/permissions-v2.test.ts` | `7731bd9b4451f12925a83465a3ebb2f289e552037464b79f39f7eda8e8878c09` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/receipts.test.ts` | `936c5eb1b0d222f3c01ca4ca6c155f994cf03119b2edf655d7af8f7228ed6913` | TypeScript | receipts | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/release-manifest-v2.test.ts` | `8799e15b800543b5c22bdc21cdbaed9a85d0aaed76c04911efc5597123f4a6a3` | TypeScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/safe-extract.test.ts` | `371531512d5ceb02de06a1d1ba9eb340902e95c773b4bbd75a5bae93a701d7e1` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/secrets.test.ts` | `9d395738b8ff93aa0e2b948ad80f624b7b025a22f3f062438a4d04f4a61f2918` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/signing.test.ts` | `cab2b31ffbe5007c640a73f6882b898a99f2ff90b6709b18fd2cd398cdb6b8dd` | TypeScript | signatures and keys | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/skill-loader.test.ts` | `2c643c81cbec84c68c980ca3a2cba8cbd49b5c939f30cdede512c4eec48ebde4` | TypeScript | skills | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/snapshot-rollback.test.ts` | `713d1d63dbaca767198fee242b21a2d709bc43b96bac9e5e8002a47c05976c9b` | TypeScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/standalone-architecture.test.ts` | `ace31e9e645065e4d86c378246c783d0da9500ee25e4c8dadd3dc781a7215cf6` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/state-store.test.ts` | `2c9d0150390fac78bd5029638dd1ba52d46c26fa2dfd5eabac6406110fc5f736` | TypeScript | state storage | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/strict-release-archive.test.ts` | `00bbf724bbb246d5fe0d4c55b0017c36e0e4a0725f79dfd187b276bf345a53f2` | TypeScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `test/symlinks.test.ts` | `bccc84b93164eb69871959e3616fd4b8bdf83677ed032e1b5a99babcf09f9d78` | TypeScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt | `tsconfig.json` | `ad9ecddb80017cc6f352f399a1c582445c9c132a77336afdcbffca328588c9c1` | JSON | configuration | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `.github/workflows/ci.yml` | `0375fe3dda4cbbb3ef004bac634c9b71818b390c3ea5f12703e392cad333129d` | YAML | GitHub authority | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `.gitignore` | `e919c6e0c041bf5f6cc76d3e4c13b9444e55c0dd7b4c413d5fe2f39de374c374` | text | packaging | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `AGENTS.md` | `07ca58ebe8d4424c2abfd1ff269cd23e11b349f05b1dd6e7834fabf5e71d52be` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `bin/baby-quirt-mcp` | `20ddcec85add2adabfa5a2fd5bcf475387996f5a1aa77c09221ed5e35d26ef17` | text | CLI | `src/gateway/cli/se-z-gateway` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `docs/GITHUB_LOGIN.md` | `1786cf10af268f7545e042832806e8e4cfdb9cb9a1fcbd0f2fbae7994e9b7b1f` | Markdown | GitHub authority | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `docs/PRODUCTION.md` | `c92790fe1883a35f51effb1f320ad77c290957605b320df9c31191d91a542cc6` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `docs/RUNBOOK.md` | `f9c50d7dc21a47a9b28156f1dea82b135a2168092419c114d10f82dacc88ed6d` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `docs/STANDALONE_DEPLOYMENT_V2.md` | `f7ebb2a34d87228d1be9a3e07fa3b1db5fb6630640fb43f601cffdf90537af9d` | Markdown | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `docs/STANDALONE.md` | `8386968d4d4f8e2cbbf3d42a898413decbe351b737e3ebe39fa393ff864034c0` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `NOTICE.md` | `f5de30eb5d784b4e40cbb0be515ed86bea37512f2078926c306c19a929fa3ac2` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `ops/bootstrap/gateway-authority-public.pem` | `0288179e795a801111cebfbba1b43fd3792f08b38c861974eff4a915d61b1ed7` | PEM public material | packaging | `packaging/bootstrap/gateway/gateway-authority-public.pem` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `ops/caddy/baby-quirt-mcp.Caddyfile` | `f3d5c04edd4e13507e81de5a0ea1c53506f03a28625bcd23facd61a9c275bd4f` | Caddy | Caddy | `packaging/caddy/se-z-gateway.Caddyfile` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `ops/systemd/baby-quirt-mcp.service` | `5f78aca3ad7744b67f8ccf34f2ba5515355633e2d877fe283e483d2f1961c98e` | systemd unit | systemd | `packaging/systemd/se-z-gateway.service` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `package-lock.json` | `370503a426a60dbafe597a4a796e529117c5cb718620e0b09ef9f1a09f65c9a6` | JSON | packaging | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `package.json` | `d42467bde6a242a1820e3746cab0bf90d611a83fbcbdc25693dd2cb7f2331948` | JSON | packaging | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `README.md` | `051d0ae1fb5da1fb2a4e0e1d478c57976724f03bee587d31ed46abfa949476f1` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `scripts/create-package-spec.mjs` | `971f016d6b29570ece5ea31a82a12001fbc7494a02ad9e6eb4deaf09a8ad69eb` | JavaScript | packaging | `scripts/extracted/gateway/create-package-spec.mjs` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `scripts/enable-github-login.sh` | `635e3657c7b68c2ae74ac411877c5da258e8925f5e624d006be7763ccb3b8478` | Shell | GitHub authority | `scripts/extracted/gateway/enable-github-login.sh` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `scripts/install-caddy-site.py` | `dcd23f5fadc4ed8923e6c08e519c55383b03925757f12fa87533ba5add02ad2f` | Python | Caddy | `scripts/extracted/gateway/install-caddy-site.py` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `scripts/live-smoke.js` | `53b006cb738d6ab4a0a4fbafdb2c6d83acf4043525d42343fcc24c0fef66fec6` | JavaScript | packaging | `scripts/extracted/gateway/live-smoke.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `scripts/oauth-github-preflight.js` | `55fbe1da7993c52e23e7bb74c5523d4a6400e02365cab4f7dd3453fe153f64cd` | JavaScript | GitHub authority | `scripts/extracted/gateway/oauth-github-preflight.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `scripts/release.sh` | `1ff5dc555dd6ce4200262d571f693f65ad06dc51f58980d92b3412bb223649c8` | Shell | release lifecycle | `scripts/extracted/gateway/release.sh` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `scripts/remote-install.sh` | `8f1e9965cbe9be1b7f29b44ce16a73d7b09e837acc6fd537c74c4c8e63ee14de` | Shell | packaging | `scripts/extracted/gateway/remote-install.sh` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `scripts/remote-rollback.sh` | `4588a4e01624ce921f37e092338774f005ac108b0aa8dc3354625596b2526313` | Shell | release lifecycle | `scripts/extracted/gateway/remote-rollback.sh` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `scripts/verify-install.sh` | `f4e8e058ae9bfe92dc89919091cc02f31c21aad98619dd9b25b953170899b48e` | Shell | packaging | `scripts/extracted/gateway/verify-install.sh` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `SECURITY.md` | `f645677e94b1bb1979f8718a3ad4c3f2a4edc623f083829cbdb5d4a2c085b80f` | Markdown | documentation | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `src/canonical.js` | `569fe75b137570c0e661ec19bfd60105f05a40eb15aa307c127d725591fe8517` | JavaScript | canonical encoding | `src/gateway/signing/canonical.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/catalog.js` | `76fd7dbf6e63484b6a246cf6617048e9e649bfd1a5c3ba0f0dccf6bc8a9e8a54` | JavaScript | MCP gateway | `src/gateway/mcp/catalog.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/client.js` | `958489f9ca0b521b6d7f67427525fabcb6450bdc2b925a5c8b4089839aafd0a5` | JavaScript | MCP gateway | `src/gateway/transport/client.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/config.js` | `ead210d38b19c7fa8917d7fe38bfe81eabcbcb8d5c1fb50bb7ccdf289f33ec28` | JavaScript | configuration | `src/gateway/configuration/config.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/main.js` | `f475c5f1eb4f2a48401990882404bf2051b7abb990ffc08200e3c0849cdb4e5b` | JavaScript | packaging | `src/gateway/mcp/main.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/oauth-server.js` | `b38483563d95b982a24d6fd288514c934d463cdd90f84249faecfc3563904470` | JavaScript | MCP gateway | `src/auth/oauth/server.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/oauth-state-durable.js` | `c601645d3b9d176fc21f5273c40aa9beb3fe6554dd4f20bd4a5e3edfc994c103` | JavaScript | OAuth | `src/auth/oauth/state-durable.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/oauth.js` | `278836e13b0301ba7706c6ce228d09a943f69bb042ae7eca76b285ca59f5ad1c` | JavaScript | OAuth | `src/auth/oauth/tokens.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/protocol.js` | `b1774aee7bf974a229da5ad0b672c1dc72c29928b93c0e3f7fd50fc917435f57` | JavaScript | protocol | `src/gateway/transport/protocol.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/server.js` | `fb80f917b976d1d485bea46a1229d343a43864048b8a9553bb7b2ba961a58ea9` | JavaScript | MCP gateway | `src/gateway/mcp/server.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `src/tool.js` | `7c4d050ef993c44ed7bfd5e4546d3c3038b1ffc8395f0919df0dd0dc53c214df` | JavaScript | MCP gateway | `src/gateway/mcp/tool.js` | PLANNED |
| StealthEyeLLC/baby-quirt-mcp | `test/caddy.test.js` | `532b34b652a0a47c74b88abb38c7213a3c9a604a9528d4c4859dce3e99eadab6` | JavaScript | Caddy | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/config.test.js` | `03f52fa54fcc0286b7991ea61c141ee79e5cc5170a5ae2a2f4ecb82e19ad105f` | JavaScript | configuration | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/contract.test.js` | `0b0577ede1c89e69f86594d18b2413f7c96cc4cc3b77bf5135e2ab92464d0705` | JavaScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/deployment.test.js` | `2426f5f6e0e099ad570e92b100d36026e4da9ad2b77c1e53412292f3116640fc` | JavaScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/entrypoint.test.js` | `83cc2918a68bd938e941dea13783baaf59e15ac3be6e955a5a85bf41d9dca18b` | JavaScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/github-login.test.js` | `1d23125a356b77d818d8f45ccaa754ec9df1a84b477351f313b2e837437d165d` | JavaScript | GitHub authority | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/integration.test.js` | `76f7c764e37f6d40f7c85776ad3dc264422ccb18b2155a44ef6b7c2c44dffacb` | JavaScript | tests | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/oauth-server.test.js` | `c6fb641fd99c9677adccedbce245f04264d8211c38f5f8c4395348488aee8369` | JavaScript | MCP gateway | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/release-v2.test.js` | `241ca2806bc2e43fb260a425107cbe29fb80434e02064df7bce92c4d7ee38d61` | JavaScript | release lifecycle | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/server.test.js` | `dda9176d7519dcd6ebeb30b8672546735f1cc3ef278fcd677a62526a77eaaaf4` | JavaScript | MCP gateway | source harness only | SOURCE_REFERENCE_ONLY |
| StealthEyeLLC/baby-quirt-mcp | `test/standalone-architecture.test.js` | `4199d3c96c101760c36ce3b9f805a1f016a07001beebd36ce37107a826147fad` | JavaScript | tests | source harness only | SOURCE_REFERENCE_ONLY |

The machine-readable record in `vendor/baby-provenance/source-map.json` additionally records exports, state paths, external processes, dependencies, source tests, rename status, canonical-delta status, and parity status.
