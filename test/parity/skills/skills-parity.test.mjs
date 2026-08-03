import test from 'node:test';
import { assertFamily } from '../assert-family.mjs';
test('skills behavior has pinned source lineage and executable target coverage', () => assertFamily('skills'));
