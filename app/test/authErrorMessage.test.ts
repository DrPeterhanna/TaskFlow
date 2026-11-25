import {it,expect} from 'vitest';
import {authErrorMessage} from '../src/auth/errorMessage';
import {strings} from '../src/i18n';
it('local build connection copy names backend and USB without blaming internet or asserting data loss',()=>{
 for(const locale of ['en','ar'] as const){expect(authErrorMessage('network',locale,{name:'local',url:'http://127.0.0.1:54321'})).toBe(strings(locale).auth.localConnection);expect(authErrorMessage('network',locale,{name:'test',url:'http://127.0.0.1:54321'})).toBe(strings(locale).auth.errors.network);}
 expect(strings('en').auth.localConnection).toContain('USB');
});
it('nonlocal, invalid config and other auth errors keep correct message',()=>{
 for(const env of [{},{name:'local',url:'https://example.test'},{name:'local',url:'bad'}])expect(authErrorMessage('network','en',env)).toBe(strings('en').auth.errors.network);
 expect(authErrorMessage('invalid_credentials','en',{name:'local',url:'http://localhost'})).toBe(strings('en').auth.errors.invalid_credentials);expect(authErrorMessage(null,'en',{})).toBeNull();
});
