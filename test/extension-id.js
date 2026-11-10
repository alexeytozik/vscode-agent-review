'use strict';
const manifest = require('../package.json');
function fromManifest(value) {
  if (!value || !['publisher', 'name'].every(key => typeof value[key] === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(value[key]))) throw new Error('The extension package needs a valid publisher and name.');
  return value.publisher + '.' + value.name;
}
module.exports = { current: fromManifest(manifest), fromManifest };
