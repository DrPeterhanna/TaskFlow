import { registerRootComponent } from 'expo';
import * as ExpoCrypto from 'expo-crypto';
import App from './App';

// React Native has no global crypto.getRandomValues; ids and op-ids need real randomness.
if (!(globalThis as { crypto?: { getRandomValues?: unknown } }).crypto?.getRandomValues) {
  (globalThis as unknown as { crypto: unknown }).crypto = { getRandomValues: ExpoCrypto.getRandomValues };
}
registerRootComponent(App);
