const ANSI_REGEX = /[\u001B\u009B][\[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-Zcf-ntqry=><~]))/g;
const testCases = [
  '\x1B(0', '\x1B#8', '\x1B=', '\x1B7', '\x1B[31mred\x1B[0m',
  '\x1B[?1049h', '\x1B]0;Title\x07', 'safe text'
];
testCases.forEach(c => console.log(JSON.stringify(c.replace(ANSI_REGEX, ''))));
