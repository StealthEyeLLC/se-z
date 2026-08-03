import test from 'node:test';
import { assertFamily } from '../assert-family.mjs';
test('artifacts behavior has pinned source lineage and executable target coverage', () => assertFamily('artifacts'));
