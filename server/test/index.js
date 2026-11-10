// `node --test server/test/` (Node 22 resolves a directory argument to this
// file) runs the whole server suite in one process. Each file can also be run
// on its own:  node --test server/test/relay.test.mjs
// or all of them in parallel processes:  node --test "server/test/*.test.mjs"
import './config.test.mjs';
import './license.test.mjs';
import './stripe.test.mjs';
import './static.test.mjs';
import './relay.test.mjs';
import './payments.test.mjs';
import './client.test.mjs';
import './lockstep.e2e.test.mjs';
