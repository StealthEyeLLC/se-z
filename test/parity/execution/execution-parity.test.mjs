import test from 'node:test';
import { assertFamily } from '../assert-family.mjs';
test('execution behavior has pinned source lineage and executable target coverage', () => assertFamily('execution'));
