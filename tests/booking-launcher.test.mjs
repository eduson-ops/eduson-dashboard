import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('published dashboard booking entry opens the platform without calling the retired writer', async () => {
  const root = { innerHTML: '' };
  const window = {};
  vm.runInNewContext(await readFile(new URL('../booking-ui.js', import.meta.url), 'utf8'), {
    window, document: { getElementById: id => id === 'booking-app' ? root : null }
  });
  window.initBookingUI(root);
  assert.match(root.innerHTML, /href="https:\/\/booking\.82\.148\.17\.109\.sslip\.io\/"/);
  assert.doesNotMatch(root.innerHTML, /<form|script\.google\.com/);
  root.innerHTML = '';
  window.refreshBookingUI();
  assert.match(root.innerHTML, /Открыть букинг/);
});

test('legacy schedule navigation opens the migrated authenticated schedule before invoking the old editor',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const source=html.match(/function showPage\(id\) \{([\s\S]*?)\n\}/)[1];
  const window={location:{assigned:null,assign(url){this.assigned=url;}}};
  vm.runInNewContext('function showPage(id){'+source+'}\nshowPage("schedule");',{window});
  assert.equal(window.location.assigned,'https://booking.82.148.17.109.sslip.io/#schedule');
});
