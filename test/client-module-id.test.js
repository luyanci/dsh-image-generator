/**
 * Regression: DSH Web client-modules refuse to boot a plugin whose
 * `__ModuleLoader__.load({ id })` does not match the package name.
 *
 * Repro from production (dsh plugin --profile desktop add dsh-image-generation):
 *   failed to import loader entry … (dsh-image-generation):
 *   client-modules: bundle /plugins/??…,dsh-image-generation/client.js,…
 *   loaded without registering "dsh-image-generation" via __ModuleLoader__.load
 *
 * Cause: 0.1.0 kept the old factory id `dsh-image-gen` after the package was
 * renamed to `dsh-image-generation`. The host graph row uses package.json
 * `name`; after the combo script runs, ClientModuleRegistry.arrive() requires
 * factories.has(packageName). Registering a different id leaves the expected
 * factory missing and aborts the whole Web shell.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function stripClientSuffix(spec) {
  return spec.endsWith('/client') ? spec.slice(0, -7) : spec
}

function loadClientFactory(source, url = '@luyanci/dsh-image-generation/client.js') {
  const factories = new Map()
  const context = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          const id = stripClientSuffix(registration.id)
          factories.set(id, registration.factory)
        },
      },
    },
  }
  vm.runInNewContext(source, context, { filename: url })
  return factories
}

function arrive(factories, id, url) {
  if (!factories.has(id)) {
    throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`)
  }
}

test('client factory id and host name match package.json name', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const clientSource = await readFile(join(root, 'client.js'), 'utf8')
  const hostSource = await readFile(join(root, 'index.js'), 'utf8')
  const url = `${pkg.name}/client.js`

  const factories = loadClientFactory(clientSource, url)
  assert.equal(factories.size, 1, 'client.js must register exactly one factory')
  assert.ok(
    factories.has(pkg.name),
    `client.js registered ${JSON.stringify([...factories.keys()])}, expected ${JSON.stringify(pkg.name)}`,
  )
  arrive(factories, pkg.name, url)

  const hostName = hostSource.match(/^export const name = '([^']+)'/m)?.[1]
  assert.equal(hostName, pkg.name)
})
