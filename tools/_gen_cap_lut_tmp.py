# one-off: generate the CAP LUT with V8's own Math.cos/sin + Math.round
from py_mini_racer import MiniRacer

JS = r"""
(function(){
  const cos = [], sin = [];
  for (let k = 0; k < 360; k++) {
    cos.push(Math.round(2 * 64 * Math.cos(k * Math.PI / 180)));
    sin.push(Math.round(2 * 64 * Math.sin(k * Math.PI / 180)));
  }
  if (cos[0] !== 128 || sin[0] !== 0 || cos[90] !== 0 || sin[90] !== 128
      || cos[180] !== -128 || sin[270] !== -128) throw 'bad sanity';
  return cos.join(',') + '\n---\n' + sin.join(',');
})()
"""

print(MiniRacer().eval(JS))
