import { usedHelper, USED_CONSTANT } from './utils';
import { LiveShape, livePair } from './shapes';

const shape: LiveShape = { id: 'root' };

console.log(usedHelper(USED_CONSTANT), shape.id, livePair);
