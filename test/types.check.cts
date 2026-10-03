// Compile-only check of the CommonJS types.
import honk = require('honk-me');
const client = new honk.Honk({ url: 'https://honk.example.com', key: 'honk_x' });
void client.recovery('g', 't', 'm');
