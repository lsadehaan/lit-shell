const terminal = document.querySelector('#terminal');
const websocketProtocol =
  window.location.protocol === 'https:' ? 'wss:' : 'ws:';

terminal.url = `${websocketProtocol}//${window.location.host}/terminal`;
terminal.connect().catch(() => {
  console.error('Unable to connect to the Docker terminal demo.');
});
