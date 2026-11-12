import {test} from 'node:test';
import assert from 'node:assert/strict';
import {slackPayloadOf,slackMessage} from '../server/vendor/ember-slack.js';
import {prepareBody} from '../server/vendor/ember-richtext.js';
test('Slack JSON and form payloads preserve formatting without sender/channel override',()=>{
  const data={text:'*Deployment* finished :tada:',username:'forged',channel:'private'};
  for(const input of [JSON.stringify(data),new URLSearchParams({payload:JSON.stringify(data)}).toString()]){
    const result=slackMessage(slackPayloadOf(input));
    assert.equal(typeof result,'object');
    assert.match(result.markup,/<strong>Deployment<\/strong>/);
    assert.equal('username' in result,false);
    assert.equal('channel' in result,false);
  }
});
test('untrusted Slack markup passes safe message preparation',()=>{
  const result=slackMessage({text:'<script>alert(1)</script> <javascript:alert(1)|click>'});
  assert.equal(typeof result,'object');
  const prepared=prepareBody(result.markup,()=>undefined);
  assert.ok(prepared);
  assert.doesNotMatch(prepared.html,/<script|href="javascript:/i);
});
test('invalid payloads and empty messages are refused',()=>{
  for(const input of ['null','[]','not JSON','{"x":'])assert.equal(slackPayloadOf(input),null);
  assert.equal(slackMessage({text:''}),'no_text');
  assert.equal(slackMessage({attachments:Array(101).fill({text:'x'})}),'too_many_attachments');
});
