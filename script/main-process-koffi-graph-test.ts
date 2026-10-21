import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { describe, it } from 'node:test'
import ts from 'typescript'

const projectRoot = path.join(__dirname, '..')
const exts = ['.ts', '.tsx', '.js', '.jsx']

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) {
    return null
  }

  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = path.extname(base) ? [base] : []
  for (const ext of exts) {
    candidates.push(base + ext, path.join(base, `index${ext}`))
  }

  return (
    candidates.find(
      candidate => existsSync(candidate) && statSync(candidate).isFile()
    ) ?? null
  )
}

function isValueSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined
): boolean {
  if (symbol === undefined) {
    return true
  }

  if (symbol.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(symbol)
    if (aliased !== undefined && aliased !== symbol) {
      return isValueSymbol(checker, aliased)
    }
  }

  return (
    (symbol.flags &
      (ts.SymbolFlags.Value |
        ts.SymbolFlags.ValueModule |
        ts.SymbolFlags.NamespaceModule |
        ts.SymbolFlags.Enum)) !==
    0
  )
}

function runtimeSpecs(
  program: ts.Program,
  checker: ts.TypeChecker,
  file: string
): ReadonlyArray<string> {
  const source = program.getSourceFile(file)
  if (source === undefined) {
    return []
  }

  const specs: string[] = []
  const add = (spec: string | undefined) => {
    if (spec !== undefined) {
      specs.push(spec)
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.isTypeOnly !== true
    ) {
      const clause = node.importClause
      let keep = clause === undefined
      if (clause !== undefined) {
        if (clause.name !== undefined) {
          keep = true
        }
        if (
          clause.namedBindings !== undefined &&
          ts.isNamespaceImport(clause.namedBindings)
        ) {
          keep = true
        }
        if (
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings)
        ) {
          keep =
            keep ||
            clause.namedBindings.elements.some(element => {
              if (element.isTypeOnly) {
                return false
              }
              return isValueSymbol(
                checker,
                checker.getSymbolAtLocation(element.name)
              )
            })
        }
      }
      if (keep && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node.moduleSpecifier.text)
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let keep = true
      if (
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      ) {
        keep = node.exportClause.elements.some(element => {
          if (element.isTypeOnly) {
            return false
          }
          return isValueSymbol(
            checker,
            checker.getSymbolAtLocation(element.name)
          )
        })
      }
      if (keep) {
        add(node.moduleSpecifier.text)
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      add(node.arguments[0].text)
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      add(node.arguments[0].text)
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return specs
}

function runtimeGraph(program: ts.Program, entry: string) {
  const checker = program.getTypeChecker()
  const seen = new Set<string>()
  const edges = new Map<string, string[]>()
  const queue = [path.resolve(entry)]

  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) {
      continue
    }
    seen.add(file)

    for (const spec of runtimeSpecs(program, checker, file)) {
      const resolved = resolveSpec(file, spec)
      if (resolved === null) {
        continue
      }
      const next = edges.get(file) ?? []
      next.push(resolved)
      edges.set(file, next)
      queue.push(resolved)
    }
  }

  return { seen, edges }
}

function pathTo(
  edges: ReadonlyMap<string, readonly string[]>,
  start: string,
  predicate: (file: string) => boolean
): string[] | null {
  const queue: Array<[string, string[]]> = [
    [path.resolve(start), [path.resolve(start)]],
  ]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) {
      break
    }
    const [file, trail] = next
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    if (predicate(file) && trail.length > 1) {
      return trail
    }
    for (const child of edges.get(file) ?? []) {
      queue.push([child, trail.concat(child)])
    }
  }

  return null
}

function relativeTrail(trail: readonly string[]): string {
  return trail.map(file => path.relative(projectRoot, file)).join('\n  -> ')
}

describe('native modules in non-renderer bundles', () => {
  const configPath = path.join(projectRoot, 'tsconfig.json')
  const configFile = ts.readConfigFile(configPath, filename =>
    readFileSync(filename, 'utf8')
  )
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    projectRoot
  )
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  })

  const copilotStore = (file: string) =>
    file.endsWith(`${path.sep}copilot-store.ts`)

  for (const entry of [
    'app/src/main-process/main.ts',
    'app/src/crash/index.tsx',
  ]) {
    it(`${entry} does not load Copilot or koffi`, () => {
      const { edges } = runtimeGraph(program, path.join(projectRoot, entry))
      const trail = pathTo(edges, path.join(projectRoot, entry), copilotStore)
      assert.equal(
        trail,
        null,
        trail === null
          ? ''
          : `Copilot SDK would be bundled with koffi.node:\n${relativeTrail(
              trail
            )}`
      )
    })
  }

  it('renderer still loads Copilot', () => {
    const entry = path.join(projectRoot, 'app/src/ui/index.tsx')
    const { edges } = runtimeGraph(program, entry)
    assert.ok(pathTo(edges, entry, copilotStore))
  })
})
