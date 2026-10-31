import ts from 'typescript';
export function inspectSource(path, content) {
  const violations = [], worker = path.startsWith('apps/worker/'), db = path.startsWith('packages/db/');
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const report = message => violations.push(`${path}: ${message}`);
  const checkModule = name => {
    if (path.startsWith('apps/web/') && ['@dealdock/ai','@dealdock/messaging'].includes(name)) report('web may not import @dealdock/ai or @dealdock/messaging; provider capabilities belong to the API');
    if (path.startsWith('apps/web/') && /^@dealdock\/speech(\/|$)/.test(name)) report('web may not import speech providers (vendor keys, voice cloning); audio reaches the browser only through signed API media links');
    if (!db && (/@prisma\//.test(name) || name.startsWith('@dealdock/db/') || /packages\/db\/(src|dist)\/(client|crypto)/.test(name) || ['pg','postgres','mysql2','better-sqlite3'].includes(name))) report('database access must use @dealdock/db repositories');
    if (worker && (name.includes('@dealdock/messaging') || /(?:instagram|graph-adapter|\/graph$)/.test(name))) report('worker may not import Graph or messaging capabilities');
  };
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkModule(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) checkModule(node.arguments[0].text);
      else if (worker) report('worker dynamic module loading must use a static literal');
    }
    if (worker && ts.isIdentifier(node) && ['sendMessage','getConnectedAccount','decryptToken','getGraphAdapter','InstagramGraphAdapter'].includes(node.text)) report(`worker may not reference ${node.text}`);
    if (worker && ts.isStringLiteral(node) && /(?:graph\.instagram\.com|graph\.facebook\.com)/i.test(node.text)) report('worker may not call Graph endpoints');
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...new Set(violations)];
}
