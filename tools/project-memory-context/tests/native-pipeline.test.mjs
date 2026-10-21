import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { executeNativePipeline } from '../src/native-pipeline.mjs';
import { refreshContext } from '../cli/refresh-context.mjs';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { buildFileCard } from '../src/cards/file-card.mjs';
import { openGraphDb } from '../src/graph-store/graph-db.mjs';
import { persistNativeRelations } from '../src/graph-store/native-relations.mjs';

const FIXTURE_DIR = new URL('./fixtures/layered-app', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');

const USER_SERVICE_CLASS = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const USER_SERVICE_FIND_BY_ID = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const USER_CONTROLLER_CLASS = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';
const USER_CONTROLLER_GET_USER = 'ts|src/controllers/user.controller.ts|method|member|UserController.getUser|1';
const TEST_USER_SERVICE = 'ts|tests/user.service.test.ts|function|exported|testUserService|0';
const CLI_MAIN = 'ts|src/cli/main.ts|function|exported|main|0';

async function connectMcp(projectRoot) {
  const server = new McpServer({ name: 'test-native-pipeline-server', version: '1.0.0' });
  registerQueryTools(server, { projectRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-native-pipeline-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function parseMcpPayload(result) {
  return JSON.parse(result.content[0].text);
}

async function assertMethodControllerBoundary(client) {
  const result = parseMcpPayload(await client.callTool({
    name: 'pmc_relations',
    arguments: {
      target: USER_SERVICE_FIND_BY_ID,
      direction: 'in',
      relations: ['calls'],
      depth: 1,
      stopAtRole: 'controller',
    },
  }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.stoppedAtRole, 'controller');
  assert.deepEqual(
    result.matches.filter((match) => match.role === 'controller').map((match) => match.symbolKey).sort(),
    [USER_CONTROLLER_GET_USER],
    'the method target must stop at the exact controller method',
  );
}

test('native-pipeline materializes canonical identities, relations, roles, and index from layered-app source without manual seeding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-test-pipeline-'));

  try {
    // Copy layered-app source files to isolated temporary project
    await cp(FIXTURE_DIR, root, { recursive: true });

    // Execute shared native pipeline on actual source files
    const result = await executeNativePipeline({ projectRoot: root });

    assert.ok(result.resolvedSymbols.length > 0, 'should extract and resolve symbols');
    assert.ok(result.calls.relations.length > 0, 'should extract native calls');

    // S1 enrichment invariant: unenriched execution must leave worklist entries pending with null memoryId
    assert.ok(result.worklist.length > 0, 'worklist should not be empty');
    assert.equal(
      result.worklist.every((w) => w.status === 'pending'),
      true,
      'unenriched symbols in worklist must have status pending, not falsely enriched',
    );
    assert.equal(
      result.worklist.every((w) => w.memoryId === null),
      true,
      'unenriched symbols in worklist must have memoryId null',
    );
    assert.equal(
      Object.values(result.symbolIndex).every((e) => e.status === 'pending'),
      true,
      'symbol index entries for fresh unenriched project must have status pending',
    );

    // Connect public MCP server to query materialized graph and roles
    const { client, close } = await connectMcp(root);

    try {
      // 1. Assert q1 incoming method calls for UserService.findById
      const q1Result = parseMcpPayload(await client.callTool({
        name: 'pmc_relations',
        arguments: { target: USER_SERVICE_FIND_BY_ID, direction: 'in', relations: ['calls'] },
      }));
      assert.equal(q1Result.status, 'resolved');
      const callers = q1Result.edges.map((e) => e.source.symbolKey ?? e.source.id).sort();
      assert.deepEqual(callers, [USER_CONTROLLER_GET_USER, TEST_USER_SERVICE].sort(), 'UserService.findById callers must match q1');

      // 2. Assert controller stop boundary for UserService class
      const stopResult = parseMcpPayload(await client.callTool({
        name: 'pmc_relations',
        arguments: { target: USER_SERVICE_CLASS, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller' },
      }));
      assert.equal(stopResult.status, 'resolved');
      assert.equal(stopResult.stoppedAtRole, 'controller');
      assert.ok(
        stopResult.matches.some((m) => m.symbolKey === USER_CONTROLLER_CLASS && m.role === 'controller'),
        'must stop at UserController controller class',
      );

      await assertMethodControllerBoundary(client);

      // 3. Assert exact q8 class entrypoint for UserService class is main
      const q8Result = parseMcpPayload(await client.callTool({
        name: 'pmc_entrypoints_for',
        arguments: { target: USER_SERVICE_CLASS },
      }));
      assert.equal(q8Result.status, 'resolved');
      const entrypoints = q8Result.entrypoints.map((e) => e.symbolKey);
      assert.deepEqual(entrypoints, [CLI_MAIN], 'q8 class entrypoint must be exactly main');

      // 4. Assert cards with verified members (file and feature cards)
      const fileCardMcp = parseMcpPayload(await client.callTool({
        name: 'pmc_card',
        arguments: { target: 'src/services/user.service.ts' },
      }));
      assert.equal(fileCardMcp.status, 'resolved');
      assert.equal(fileCardMcp.facts.kind, 'file');
      assert.ok(
        fileCardMcp.facts.members.some((m) => m.symbolKey === USER_SERVICE_FIND_BY_ID),
        'file card via MCP must verify findById member',
      );

      const featureCardMcp = parseMcpPayload(await client.callTool({
        name: 'pmc_feature_card',
        arguments: {
          name: 'user-service-feature',
          members: [
            USER_SERVICE_CLASS,
            USER_SERVICE_FIND_BY_ID,
            'file|src/services/user.service.ts',
          ],
        },
      }));
      assert.equal(featureCardMcp.kind, 'feature-card');
      assert.equal(featureCardMcp.name, 'user-service-feature');
      assert.ok(
        featureCardMcp.symbols.some((s) => s.symbolKey === USER_SERVICE_FIND_BY_ID),
        'feature card must verify findById symbol',
      );
      assert.ok(
        featureCardMcp.files.some((f) => f.path === 'src/services/user.service.ts'),
        'feature card must verify user.service.ts file',
      );
      assert.equal(featureCardMcp.rejected.length, 0, 'valid members must not be rejected');

      const store = openGraphDb(
        join(root, '.planning', 'project-memory-context', 'graph', 'graph.db'),
        join(root, '.planning', 'project-memory-context', 'graph', 'graph.json'),
      );
      try {
        const fileCard = buildFileCard(store, 'src/services/user.service.ts');
        assert.equal(fileCard.kind, 'file');
        const memberKeys = fileCard.members.map((m) => m.symbolKey).sort();
        assert.ok(memberKeys.includes(USER_SERVICE_FIND_BY_ID), 'file card members must include findById');
        assert.ok(fileCard.members.length >= 2, 'file card should contain constructor and findById');
      } finally {
        store.close();
      }
    } finally {
      await close();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('source edit/removal then public refresh removes obsolete structural relationships and retains prior enrichment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-test-refresh-'));

  try {
    await cp(FIXTURE_DIR, root, { recursive: true });

    // Initial pipeline run to establish baseline
    await executeNativePipeline({ projectRoot: root });

    // Seed prior accepted enrichment on an unrelated symbol (CLI_MAIN)
    const indexPath = join(root, '.planning', 'project-memory-context', 'enrichment', 'symbol-index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.ok(index[CLI_MAIN], 'CLI_MAIN must exist in symbol index');
    index[CLI_MAIN] = {
      ...index[CLI_MAIN],
      memoryId: 'mem-main-prior-123',
      status: 'enriched',
      semanticSummary: 'Authoritative CLI main entrypoint.',
      lastEnrichedAt: '2026-10-01T10:00:00.000Z',
    };
    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

    // Also update worklist to reflect prior enrichment
    const worklistPath = join(root, '.planning', 'project-memory-context', 'enrichment', 'worklist.json');
    const worklist = JSON.parse(await readFile(worklistPath, 'utf8'));
    const mainEntry = worklist.find((e) => e.symbolKey === CLI_MAIN);
    if (mainEntry) {
      mainEntry.memoryId = 'mem-main-prior-123';
      mainEntry.status = 'enriched';
    }
    await writeFile(worklistPath, JSON.stringify(worklist, null, 2), 'utf8');

    // Now remove a source file that has relations: format.ts (called by UserService.findById)
    await unlink(join(root, 'src', 'utils', 'format.ts'));

    // Run public refreshContext with hermetically stubbed external boundaries (no global graphify or background sync)
    let stubGraphifyCalled = false;
    let stubBackgroundSyncCalled = false;
    const refreshResult = await refreshContext(root, {
      runGraphifyUpdate: async () => {
        stubGraphifyCalled = true;
        return { ran: false, copied: [] };
      },
      spawnBackground: () => {
        stubBackgroundSyncCalled = true;
        return 1;
      },
      open: async () => ({ fd: 1, close: async () => {} }),
    });

    assert.equal(stubGraphifyCalled, true, 'refreshContext must invoke the injected runGraphifyUpdate stub');
    assert.equal(stubBackgroundSyncCalled, true, 'refreshContext must invoke the injected spawnBackground stub');

    assert.ok(refreshResult.removed > 0 || refreshResult.total > 0, 'refresh should detect removed file');

    // Verify obsolete structural relationships to formatName are removed from graph.db
    const store = openGraphDb(
      join(root, '.planning', 'project-memory-context', 'graph', 'graph.db'),
      join(root, '.planning', 'project-memory-context', 'graph', 'graph.json'),
    );
    try {
      const edges = store.listNativeEdges({ relation: 'calls' });
      const touchesFormat = edges.some(
        (e) => e.target.id.includes('formatName') || e.source.id.includes('formatName'),
      );
      assert.equal(touchesFormat, false, 'obsolete edges to removed format.ts must be absent');
    } finally {
      store.close();
    }

    // Verify prior enrichment for CLI_MAIN is preserved in symbol-index.json
    const updatedIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.equal(updatedIndex[CLI_MAIN]?.memoryId, 'mem-main-prior-123', 'memoryId must be preserved');
    assert.equal(updatedIndex[CLI_MAIN]?.status, 'enriched', 'enriched status must be preserved');
    assert.equal(updatedIndex[CLI_MAIN]?.semanticSummary, 'Authoritative CLI main entrypoint.', 'semanticSummary must be preserved');
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('rejected inputs to persistNativeRelations leave stored data unchanged', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const validBatch = {
      relations: [
        {
          relation: 'calls',
          source: { id: CLI_MAIN, symbolKey: CLI_MAIN, kind: 'function', path: 'src/cli/main.ts' },
          target: { id: USER_CONTROLLER_GET_USER, symbolKey: USER_CONTROLLER_GET_USER, kind: 'method', path: 'src/controllers/user.controller.ts' },
        },
      ],
      unresolved: [],
    };
    persistNativeRelations(db, validBatch);

    const initialRows = db.prepare('SELECT COUNT(*) as count FROM native_edges').get().count;
    assert.equal(initialRows, 1, 'should have 1 valid edge');

    // Attempt invalid batch with raw string target (must throw TypeError)
    const invalidBatch = {
      relations: [
        {
          relation: 'calls',
          source: { id: CLI_MAIN, symbolKey: CLI_MAIN, kind: 'function', path: 'src/cli/main.ts' },
          target: 'not-a-valid-endpoint-object',
        },
      ],
      unresolved: [],
    };

    assert.throws(() => {
      persistNativeRelations(db, invalidBatch);
    }, TypeError);

    // Assert stored data remains unchanged
    const afterRows = db.prepare('SELECT COUNT(*) as count FROM native_edges').get().count;
    assert.equal(afterRows, initialRows, 'stored rows count must remain unchanged after rejected batch');
  } finally {
    db.close();
  }
});

test('build-worklist CLI produces valid worklist and preserves previous exit/stdout behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-test-build-worklist-'));
  const buildWorklistScript = fileURLToPath(new URL('../cli/build-worklist.mjs', import.meta.url));

  try {
    await cp(FIXTURE_DIR, root, { recursive: true });

    // 1. Valid execution with files
    const files = ['src/cli/main.ts', 'src/services/user.service.ts'];
    const r = spawnSync(process.execPath, [buildWorklistScript, ...files], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(r.status, 0, `build-worklist should exit 0. stderr: ${r.stderr}`);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.saved, true);
    assert.ok(output.count > 0);

    const worklistPath = join(root, '.planning', 'project-memory-context', 'enrichment', 'worklist.json');
    const worklist = JSON.parse(await readFile(worklistPath, 'utf8'));
    assert.equal(worklist.length, output.count);

    // 2. Rejected execution with 0 arguments: leaves stored data unchanged, exits 1
    const rNoArgs = spawnSync(process.execPath, [buildWorklistScript], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(rNoArgs.status, 1, 'build-worklist with 0 arguments must exit 1');
    assert.match(rNoArgs.stderr, /Usage: node build-worklist\.mjs <file1> \[file2 \.\.\.\]/);

    // Stored worklist remains unchanged
    const afterWorklist = JSON.parse(await readFile(worklistPath, 'utf8'));
    assert.deepEqual(afterWorklist, worklist, 'stored worklist must remain unchanged after rejected invocation');
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('native-pipeline with stubbed external Graphify AST matches real Graphify node IDs and resolves all golden queries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-test-stubbed-graphify-'));

  try {
    await cp(FIXTURE_DIR, root, { recursive: true });

    // Deterministic Graphify AST graph fixture (mimicking graphify update output)
    const graphifyNodes = [
      { id: 'cli_main_main', label: 'main()', kind: 'function', source_file: 'src/cli/main.ts', source_location: 'L3' },
      { id: 'controllers_user_controller_usercontroller', label: 'UserController', kind: 'class', source_file: 'src/controllers/user.controller.ts', source_location: 'L4' },
      { id: 'controllers_user_controller_usercontroller_getuser', label: '.getUser()', kind: 'method', source_file: 'src/controllers/user.controller.ts', source_location: 'L7' },
      { id: 'services_user_service_userservice', label: 'UserService', kind: 'class', source_file: 'src/services/user.service.ts', source_location: 'L5', community: 1 },
      { id: 'services_user_service_userservice_constructor', label: '.constructor()', kind: 'method', source_file: 'src/services/user.service.ts', source_location: 'L8', community: 1 },
      { id: 'services_user_service_userservice_findbyid', label: '.findById()', kind: 'method', source_file: 'src/services/user.service.ts', source_location: 'L12', community: 1 },
      { id: 'repositories_user_repository_userrepository', label: 'UserRepository', kind: 'class', source_file: 'src/repositories/user.repository.ts', source_location: 'L3' },
      { id: 'repositories_user_repository_userrepository_findone', label: '.findOne()', kind: 'method', source_file: 'src/repositories/user.repository.ts', source_location: 'L4' },
      { id: 'db_client_databaseclient', label: 'DatabaseClient', kind: 'class', source_file: 'src/db/client.ts', source_location: 'L1' },
      { id: 'db_client_databaseclient_query', label: '.query()', kind: 'method', source_file: 'src/db/client.ts', source_location: 'L2' },
      { id: 'models_user_model_user', label: 'User', kind: 'interface', source_file: 'src/models/user.model.ts', source_location: 'L1' },
      { id: 'models_user_model_userentity', label: 'UserEntity', kind: 'class', source_file: 'src/models/user.model.ts', source_location: 'L5' },
      { id: 'interfaces_user_repository_iuserrepository', label: 'IUserRepository', kind: 'interface', source_file: 'src/interfaces/user-repository.ts', source_location: 'L3' },
      { id: 'utils_format_formatname', label: 'formatName()', kind: 'function', source_file: 'src/utils/format.ts', source_location: 'L1' },
      { id: 'views_user_view_renderuser', label: 'renderUser()', kind: 'function', source_file: 'src/views/user.view.ts', source_location: 'L3' },
      { id: 'tests_user_service_test_testuserservice', label: 'testUserService()', kind: 'function', source_file: 'tests/user.service.test.ts', source_location: 'L3' },
    ];
    const initialGraph = { nodes: graphifyNodes, links: [] };

    // Execute native pipeline with the stubbed Graphify AST graph
    const result = await executeNativePipeline({
      projectRoot: root,
      graph: initialGraph,
    });

    // Verify canonical identities matched Graphify node IDs
    const findByIdSymbol = result.resolvedSymbols.find((s) => s.symbolKey === USER_SERVICE_FIND_BY_ID);
    assert.equal(findByIdSymbol.graphNodeId, 'services_user_service_userservice_findbyid', 'must resolve to Graphify node ID');

    // Public MCP queries
    const { client, close } = await connectMcp(root);
    try {
      // q1
      const q1 = parseMcpPayload(await client.callTool({
        name: 'pmc_relations',
        arguments: { target: USER_SERVICE_FIND_BY_ID, direction: 'in', relations: ['calls'] },
      }));
      assert.equal(q1.status, 'resolved');
      const callers = q1.edges.map((e) => e.source.symbolKey ?? e.source.id).sort();
      assert.deepEqual(callers, [USER_CONTROLLER_GET_USER, TEST_USER_SERVICE].sort());

      // stopAtRole: controller
      const stopAtCtrl = parseMcpPayload(await client.callTool({
        name: 'pmc_relations',
        arguments: { target: USER_SERVICE_CLASS, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller' },
      }));
      assert.equal(stopAtCtrl.status, 'resolved');
      assert.equal(stopAtCtrl.stoppedAtRole, 'controller');
      assert.ok(stopAtCtrl.matches.some((m) => m.symbolKey === USER_CONTROLLER_CLASS && m.role === 'controller'));

      await assertMethodControllerBoundary(client);

      // q8: entrypoint
      const q8 = parseMcpPayload(await client.callTool({
        name: 'pmc_entrypoints_for',
        arguments: { target: USER_SERVICE_CLASS },
      }));
      assert.equal(q8.status, 'resolved');
      assert.deepEqual(q8.entrypoints.map((e) => e.symbolKey), [CLI_MAIN]);

      // file-card members
      const store = openGraphDb(
        join(root, '.planning', 'project-memory-context', 'graph', 'graph.db'),
        join(root, '.planning', 'project-memory-context', 'graph', 'graph.json'),
      );
      try {
        const card = buildFileCard(store, 'src/services/user.service.ts');
        const memberIds = card.members.map((m) => m.id).sort();
        assert.ok(memberIds.includes('services_user_service_userservice_findbyid'), 'card members must use Graphify node ID');
      } finally {
        store.close();
      }

      // community-card members via MCP
      const commCard = parseMcpPayload(await client.callTool({
        name: 'pmc_community_card',
        arguments: { communityId: '1' },
      }));
      assert.equal(commCard.kind, 'community-card');
      assert.equal(commCard.communityId, '1');
      assert.ok(
        commCard.members.some((m) => m.id === 'services_user_service_userservice_findbyid'),
        'community card members must include findbyid',
      );
    } finally {
      await close();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('repeated native-pipeline execution over unchanged unenriched source keeps worklist and index pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-test-repeat-pipeline-'));

  try {
    await cp(FIXTURE_DIR, root, { recursive: true });

    // First pass
    const first = await executeNativePipeline({ projectRoot: root });
    assert.equal(first.worklist.every((w) => w.status === 'pending'), true);
    assert.equal(Object.values(first.symbolIndex).every((e) => e.status === 'pending'), true);

    // Second pass without source edits or enrichment
    const second = await executeNativePipeline({ projectRoot: root });
    assert.equal(second.worklist.length, first.worklist.length);
    assert.equal(
      second.worklist.every((w) => w.status === 'pending'),
      true,
      'repeat unenriched generation must keep worklist entries pending',
    );
    assert.equal(
      second.worklist.every((w) => w.memoryId === null),
      true,
      'repeat unenriched generation must keep memoryId null',
    );
    assert.equal(
      Object.values(second.symbolIndex).every((e) => e.status === 'pending'),
      true,
      'repeat unenriched generation must keep symbolIndex entries pending',
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('native-pipeline marks changed source after accepted hash as pending while preserving unchanged accepted symbol and metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-test-changed-source-'));

  try {
    await cp(FIXTURE_DIR, root, { recursive: true });

    // Initial run
    await executeNativePipeline({ projectRoot: root });

    const indexPath = join(root, '.planning', 'project-memory-context', 'enrichment', 'symbol-index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));

    // Controlled accepted semantic prestate for two symbols using existing schema
    assert.ok(index[USER_SERVICE_FIND_BY_ID], 'find_by_id must exist in index');
    assert.ok(index[CLI_MAIN], 'cli_main must exist in index');

    index[USER_SERVICE_FIND_BY_ID] = {
      ...index[USER_SERVICE_FIND_BY_ID],
      memoryId: 'mem-findbyid-accepted',
      status: 'enriched',
      semanticSummary: 'Finds a user record by primary key.',
      lastEnrichedAt: '2026-10-10T10:00:00.000Z',
    };
    index[CLI_MAIN] = {
      ...index[CLI_MAIN],
      memoryId: 'mem-main-accepted',
      status: 'enriched',
      semanticSummary: 'Main CLI entrypoint.',
      lastEnrichedAt: '2026-10-10T10:00:00.000Z',
    };
    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

    // Modify user.service.ts source to change codeHash of findById
    const servicePath = join(root, 'src', 'services', 'user.service.ts');
    const originalContent = await readFile(servicePath, 'utf8');
    const modifiedContent = originalContent.replace(
      'name: formatName(user.name),',
      'name: formatName(user.name ?? ""),',
    );
    assert.notEqual(originalContent, modifiedContent);
    await writeFile(servicePath, modifiedContent, 'utf8');

    // Run native pipeline after source modification
    const result = await executeNativePipeline({ projectRoot: root });

    // 1. Modified symbol (findById) must become pending in worklist and index, while preserving metadata
    const changedWl = result.worklist.find((w) => w.symbolKey === USER_SERVICE_FIND_BY_ID);
    assert.ok(changedWl, 'findById must be in worklist');
    assert.equal(changedWl.status, 'pending', 'modified source must transition worklist to pending');
    assert.equal(changedWl.memoryId, 'mem-findbyid-accepted', 'memoryId must be preserved in worklist');

    const changedIdx = result.symbolIndex[USER_SERVICE_FIND_BY_ID];
    assert.ok(changedIdx, 'findById must be in symbolIndex');
    assert.equal(changedIdx.status, 'pending', 'modified source must transition symbolIndex to pending');
    assert.equal(changedIdx.memoryId, 'mem-findbyid-accepted', 'memoryId must be preserved in symbolIndex');
    assert.equal(changedIdx.semanticSummary, 'Finds a user record by primary key.', 'semanticSummary must be preserved');
    assert.equal(changedIdx.lastEnrichedAt, '2026-10-10T10:00:00.000Z', 'lastEnrichedAt must be preserved');

    // 2. Unchanged symbol (CLI_MAIN) must remain enriched
    const unchangedWl = result.worklist.find((w) => w.symbolKey === CLI_MAIN);
    assert.ok(unchangedWl, 'CLI_MAIN must be in worklist');
    assert.equal(unchangedWl.status, 'enriched', 'unchanged accepted symbol must remain enriched in worklist');
    assert.equal(unchangedWl.memoryId, 'mem-main-accepted');

    const unchangedIdx = result.symbolIndex[CLI_MAIN];
    assert.ok(unchangedIdx, 'CLI_MAIN must be in symbolIndex');
    assert.equal(unchangedIdx.status, 'enriched', 'unchanged accepted symbol must remain enriched in symbolIndex');
    assert.equal(unchangedIdx.memoryId, 'mem-main-accepted');
    assert.equal(unchangedIdx.semanticSummary, 'Main CLI entrypoint.');
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
