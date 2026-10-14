import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gameTransitions,gamePeriod,gameScoreStatus} from '../NotificationGameEvents.sys.mjs';
import {parseGames} from '../NotificationData.sys.mjs';

const live={id:'game',league:'nfl',sport:'football',state:'in',period:1,displayClock:'10:00',status:'Q1 10:00',home:'Browns',away:'Steelers',homeAbbr:'CLE',awayAbbr:'PIT',homeScore:'0',awayScore:'0'};
const keys=(a,b)=>gameTransitions(a,b).map(e=>e.key);
test('score subtitles use reported period and clock from ESPN or Google status',()=>{
  assert.equal(gameScoreStatus({...live,period:3,displayClock:'9:47',status:'in'}),'Q3 ● 9:47');
  assert.equal(gameScoreStatus({...live,period:0,displayClock:'',status:'Q3 9:47'}),'Q3 ● 9:47');
  assert.equal(gameScoreStatus({...live,league:'nhl',sport:'hockey',period:2,displayClock:'4:12'}),'P2 ● 4:12');
  assert.equal(gameScoreStatus({...live,period:5,status:'OT',displayClock:'3:01'}),'OT ● 3:01');
});
test('breaks, finals and missing clocks do not show a misleading running timer',()=>{
  assert.equal(gameScoreStatus({...live,status:'Halftime',period:2}),'Halftime');
  assert.equal(gameScoreStatus({...live,completed:true,status:'Final',period:4}),'Final');
  assert.equal(gameScoreStatus({...live,status:'End of 1st',displayClock:'0:00'}),'End Q1');
  assert.equal(gameScoreStatus({...live,status:'Q3',period:3,displayClock:''}),'Q3');
  assert.equal(gameScoreStatus({...live,status:'Q3',period:3,displayClock:'9:99'}),'Q3');
});
test('games start on transition, joining live does not invent earlier events and old finals stay quiet',()=>{
  assert.deepEqual(keys(null,live),['game:start']);assert.equal(gameTransitions(null,live)[0].title,'Game live');
  assert.deepEqual(keys({...live,state:'pre'},live),['game:start','period:start:1']);
  assert.deepEqual(keys(null,{...live,state:'post',completed:true}),[]);
  assert.deepEqual(keys(live,{...live,displayClock:'9:59',status:'Q1 9:59'}),[]);
});
test('score changes identify scorers, corrections are named and incomplete scores are ignored',()=>{
  assert.equal(gameTransitions(live,{...live,awayScore:'7'})[0].title,'PIT scores');
  assert.equal(gameTransitions({...live,awayScore:'7'},{...live,awayScore:'6'})[0].title,'Score corrected');
  assert.deepEqual(keys({...live,awayScore:''},{...live,awayScore:'7'}),[]);
  assert.deepEqual(keys(live,{...live,homeScore:'unknown'}),[]);
});
test('quarter ends and starts are distinct; halftime and clock ticks do not repeat boundaries',()=>{
  const end={...live,status:'End of 1st',displayClock:'0:00',statusName:'STATUS_END_PERIOD'};
  assert.deepEqual(keys(live,end),['period:end:1']);assert.deepEqual(keys(end,end),[]);
  const second={...live,period:2,status:'Q2 15:00',displayClock:'15:00'};
  assert.deepEqual(keys(end,second),['period:start:2']);
  const half={...second,status:'Halftime',statusName:'STATUS_HALFTIME',displayClock:'0:00'};
  assert.deepEqual(keys(second,half),['period:end:2']);
  assert.deepEqual(keys(half,{...second,period:3,status:'Q3 15:00'}),['period:start:3']);
});
test('a skipped break still ends the known quarter, starts the current one and invents no middle quarters',()=>{
  assert.deepEqual(keys(live,{...live,period:3,status:'Q3 15:00',displayClock:'15:00'}),['period:end:1','period:start:3']);
});
test('overtime and final score changes can arrive with the final boundary',()=>{
  const fourth={...live,period:4,status:'Q4 1:00'};
  assert.deepEqual(keys(fourth,{...live,period:5,status:'OT 10:00'}),['period:end:4','period:start:5']);
  assert.equal(gamePeriod({...live,period:5,status:'OT'}).label,'Overtime');
  const final={...fourth,state:'post',completed:true,homeScore:'3',status:'Final'};
  assert.deepEqual(keys(fourth,final),['score:0:0>0:3','period:end:4','game:end']);
  assert.deepEqual(keys(final,{...final,homeScore:'4'}),[]);
});
test('Google score status labels supply period boundaries without ESPN fields',()=>{
  const a={...live,state:undefined,period:undefined,displayClock:undefined},b={...a,status:'End of 1st'};
  assert.deepEqual(keys(a,b),['period:end:1']);
  assert.deepEqual(keys(b,{...a,status:'Q2 15:00'}),['period:start:2']);
});
test('hockey periods are named correctly and ESPN status fields survive parsing',()=>{
  assert.equal(gamePeriod({...live,league:'nhl',sport:'hockey',status:'1st'}).label,'Period 1');
  const game=parseGames({events:[{id:'1',status:{period:2,displayClock:'0:00',type:{state:'in',name:'STATUS_END_PERIOD',shortDetail:'End of 2nd'}},competitions:[{competitors:[{homeAway:'home',team:{id:'1',displayName:'Home'}},{homeAway:'away',team:{id:'2',displayName:'Away'}}]}]}]},'nba')[0];
  assert.equal(game.period,2);assert.equal(game.displayClock,'0:00');assert.equal(game.statusName,'STATUS_END_PERIOD');
});
