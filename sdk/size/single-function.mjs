import { bufferToHex } from 'invisible-wallet-sdk';

// A consumer must keep the called utility without shipping unrelated wallet features.
console.log(bufferToHex(new Uint8Array([0, 1, 254, 255])));
