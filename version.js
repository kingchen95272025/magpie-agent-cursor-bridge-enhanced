// Single runtime source for the plugin version.
//
// Magpie's agent sandbox only resolves modules beside agent.js and rejects
// node: builtins, so this file must stay import-free. package.json and
// integrity.json are checked against it by verifyPackage() and the test suite;
// changing the version means editing those two files as well.
export const version = '0.2.40';
