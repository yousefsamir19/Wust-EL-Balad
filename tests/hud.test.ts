import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampCamera, zoomAt, screenToTile, pickCitizen } from '../client/src/game/camera';
import { TREE_POSITIONS, LAMP_POSITIONS } from '../shared/world.js';
import { openWorld } from '../server/src/db/index.js';
import { projectWorld } from '../server/src/realtime/projection.js';
import { walkable } from '../server/src/simulation/navigation.js';

test('camera bounds and zoom remain crisp integer scales',()=>{
  assert.deepEqual(clampCamera({x:-100,y:9000,zoom:1},640,480),{x:320,y:784,zoom:1});
  assert.equal(clampCamera({x:0,y:0,zoom:9},640,480).zoom,4);
  assert.equal(clampCamera({x:0,y:0,zoom:.5},640,480).zoom,1);
  assert.deepEqual(clampCamera({x:0,y:0,zoom:1},2000,2000),{x:640,y:512,zoom:1});
});
test('zoom preserves the world point under the cursor and hit testing chooses citizens',()=>{
  const camera={x:640,y:512,zoom:1};const point={x:420,y:300};
  const before=screenToTile(camera,point,640,480);
  const next=zoomAt(camera,2,point,640,480);
  assert.deepEqual(screenToTile(next,point,640,480),before);
  assert.equal(pickCitizen([{id:'karim',x:10,y:10}],{x:10.5,y:10.4}),'karim');
  assert.equal(pickCitizen([{id:'karim',x:10,y:10}],{x:20,y:20}),null);
});
test('visible scenery has matching authoritative collision footprints',()=>{
  for(const point of [...TREE_POSITIONS,...LAMP_POSITIONS]) assert.equal(walkable(point,[]),false);
});
test('the character sheet exposes public stats but never private thoughts or secret knowledge',()=>{
  const db=openWorld(':memory:');
  try {
    db.prepare("UPDATE citizens SET thoughts='PRIVATE TRUE SECRET' WHERE id='karim'").run();
    const citizen=projectWorld(db,1).citizens.find((value)=>value.id==='karim')!;
    assert.equal(citizen.money,60000);assert.equal(citizen.needs.energy,85);
    assert.ok(citizen.publicThought);assert.equal(JSON.stringify(citizen).includes('PRIVATE TRUE SECRET'),false);
    assert.equal('memories' in citizen,false);assert.equal('secrets' in citizen,false);
  } finally {db.close();}
});
