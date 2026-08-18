// Listens for global key events and prints them, to verify the hook sees
// input (real or synthesised). Runs for 12 seconds.
const { uIOhook, EventType } = require('uiohook-napi');

let count = 0;
uIOhook.on('keydown', (e) => {
  count++;
  console.log(`DOWN keycode=${e.keycode} type=${e.type} ctrl=${e.ctrlKey} meta=${e.metaKey}`);
});
uIOhook.on('keyup', (e) => {
  count++;
  console.log(`UP   keycode=${e.keycode} type=${e.type} ctrl=${e.ctrlKey} meta=${e.metaKey}`);
});

console.log('EventType.EventKeyPressed =', EventType.EventKeyPressed);
console.log('EventType.EventKeyReleased =', EventType.EventKeyReleased);
console.log('listening for 12s...');
uIOhook.start();

setTimeout(() => {
  uIOhook.stop();
  console.log(`saw ${count} key events`);
  process.exit(0);
}, 12000);
