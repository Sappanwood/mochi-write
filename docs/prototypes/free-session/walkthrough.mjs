import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import process from 'node:process';
const url=process.argv[2];
assert.match(url||'', /^http:\/\/127\.0\.0\.1:\d+\/?$/);
const browser=await chromium.launch({headless:true});
let count=0;
const log=text=>process.stdout.write(`PASS ${++count}: ${text}\n`);
try {
for(const width of [1280,390]) {
const page=await browser.newPage({viewport:{width,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.goto(url);
const info=async()=>{if(width===390)await page.locator('#information-tab').click();};
const discussion=async()=>{if(width===390)await page.locator('#discussion-tab').click();};
const text=id=>page.locator(id).textContent();
const same=async(id,expected)=>assert.equal(await text(id),expected);
await page.locator('summary').first().click();
await page.locator('#message').fill('输入保持');
await info();
const initial=await text('#view-id');
await page.locator('#attach').click();
await discussion();await page.locator('#generate-a').click();await page.locator('#generate-b').click();
await info();await same('#view-id',initial);assert.match(await text('#refs'),/第 1 稿/);
await discussion();assert.equal(await page.locator('#message').inputValue(),'输入保持');log(`${width}px 新甲2/乙2到达不抢阅读、保留输入及甲1引用`);
await info();await page.locator('#group').selectOption('b');assert.match(await text('#view-id'),/draft-b-2/);await page.locator('#version').selectOption('draft-b-1');assert.match(await text('#view-id'),/draft-b-1/);assert.match(await text('#refs'),/角色甲/);
await page.locator('#explore').click();await page.locator('#back').click();assert.match(await text('#view-id'),/draft-b-1/);log(`${width}px 交错组内旧稿与explorer往返不改变引用`);
await discussion();await page.getByRole('button',{name:'删除引用 draft-a-1'}).click();await same('#refs','无');await page.locator('#message').fill('@林岚');assert.ok(await page.locator('#suggestions button').count()>=4);await page.locator('#message').press('ArrowDown');await page.keyboard.press('Enter');assert.match(await text('#refs'),/draft|角色甲/);log(`${width}px @同名显示组/ID/版本且键盘选择可用`);
await page.getByRole('button',{name:'删除引用 draft-a-1'}).click();
await info();await page.locator('#group').selectOption('a');await page.locator('#version').selectOption('draft-a-1');await page.locator('#prepare-save').click();await discussion();await page.locator('#send').click();assert.match(await text('#target'),/draft-a-1/);await info();await page.locator('#group').selectOption('b');await discussion();assert.match(await text('#target'),/draft-a-1/);await page.locator('#commit').click();assert.match(await text('#target'),/待核实/);const pendingTarget=await text('#target');await info();await page.locator('#attach').click();await discussion();const pendingRefs=await text('#refs');await page.locator('#message').fill('下一轮：讨论新角色的性格');await page.locator('#send').click();await same('#target',pendingTarget);assert.equal(await page.locator('#message').inputValue(),'下一轮：讨论新角色的性格');await same('#refs',pendingRefs);assert.match(await text('#timeline'),/previous_operation_pending/);await page.locator('#cancel').click();assert.match(await text('#target'),/待核实/);await page.locator('#verify').click();assert.match(await text('#receipt'),/draft-a-1/);assert.equal(await page.locator('#message').inputValue(),'下一轮：讨论新角色的性格');await same('#refs',pendingRefs);await page.locator('#send').click();assert.match(await text('#target'),/未指定/);assert.equal(await page.locator('#message').inputValue(),'');assert.match(await text('#receipt'),/draft-a-1/);log(`${width}px 旧稿OP待核实时阻止新发送并保留输入/引用，原OP核实后可继续且收据保留`);
await page.locator('#message').fill('找到之前那个侦探角色，把职业改成记者并保存');await page.locator('#send').click();assert.match(await text('#target'),/待检索/);assert.doesNotMatch(await text('#target'),/asset-master/);await page.locator('#ambiguous').click();assert.match(await text('#target'),/需澄清/);await page.locator('#cancel').click();await page.locator('#resolve').click();assert.match(await text('#target'),/已撤回/);log(`${width}px 目标未知不提前显示对象；多目标澄清、迟到结果不激活`);
await page.locator('#message').fill('找到之前那个侦探角色，把职业改成记者并保存');await page.locator('#send').click();await page.locator('#resolve').click();assert.match(await text('#target'),/asset-master/);log(`${width}px 自然检索后才显示确切目标和基础版本`);
await page.locator('#make-story').click();await info();await page.locator('#group').selectOption('story');assert.match(await text('#content'),/draft-a-1/);await discussion();await page.locator('#make-master').click();await info();await page.locator('#group').selectOption('c');assert.match(await text('#content'),/排除：首章来信剧情/);assert.match(await text('#identity'),/session-demo/);log(`${width}px 甲未存母版→冻结故事候选→独立母版，session标识保持`);
await discussion();await page.locator('summary').nth(1).click();await page.locator('#source-old').click();await info();assert.match(await text('#content'),/实际读取的旧版本/);await discussion();await page.locator('#source-missing').click();await info();assert.match(await text('#content'),/原版本不可取得/);assert.equal(await page.locator('#attach').isDisabled(),true);await same('#refs','无');log(`${width}px 自主来源可复阅旧版、缺失不冒充且浏览不附加引用`);
await discussion();await page.locator('#message').fill('手机往返保留输入');await info();await discussion();assert.equal(await page.locator('#message').inputValue(),'手机往返保留输入');assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),true);assert.deepEqual(errors,[]);log(`${width}px 面板往返保持输入，无水平溢出、无浏览器脚本异常`);
await page.close();
}
process.stdout.write(`COMPLETE ${count} browser walkthrough assertions\n`);
} finally {await browser.close();}
