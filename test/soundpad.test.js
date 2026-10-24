'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SoundpadClient } = require('../src/main/soundpad');
const { loadLibrary } = require('../src/main/library');
const { startMockSoundpad, defaultHandler, tempPipePath, SAMPLE_CATEGORIES } = require('./helpers');

async function withMock(handler, fn, clientOpts = {}) {
  const mock = await startMockSoundpad(handler);
  const client = new SoundpadClient({ pipePath: mock.pipePath, ...clientOpts });
  try {
    await fn(client, mock);
  } finally {
    client.close();
    await mock.close();
  }
}

test('клиент: IsAlive, версии, простые ответы', async () => {
  await withMock(defaultHandler, async (c) => {
    assert.equal(await c.isAlive(), true);
    assert.equal(await c.getVersion(), '9.9.9');
    assert.equal(await c.getRcVersion(), '1.1.2');
  });
});

test('клиент: команды воспроизведения форматируются по документации', async () => {
  await withMock(defaultHandler, async (c, mock) => {
    assert.deepEqual(await c.playFromCategory(2, 5, true, false), { ok: true, response: 'R-200' });
    await c.playSound(7, false, true);
    await c.stop();
    assert.deepEqual(mock.commands, ['DoPlaySoundFromCategory(2, 5, true, false)', 'DoPlaySound(7, false, true)', 'DoStopSound()']);
  });
});

test('клиент: нецелые аргументы отклоняются (защита от инъекции в команду)', async () => {
  await withMock(defaultHandler, async (c, mock) => {
    await assert.rejects(() => c.playFromCategory('1); DoStopSound(', 1), TypeError);
    await assert.rejects(() => c.playSound(1.5), TypeError);
    assert.equal(mock.commands.length, 0);
  });
});

test('клиент: ответ R-404 не считается успехом', async () => {
  await withMock(
    (cmd) => (cmd.startsWith('DoPlay') ? 'R-404' : defaultHandler(cmd)),
    async (c) => {
      const r = await c.playSound(1);
      assert.equal(r.ok, false);
      assert.equal(r.response, 'R-404');
    }
  );
});

test('клиент: большой XML, пришедший кусками, собирается целиком', async () => {
  const big = `<Soundlist>${Array.from({ length: 4000 }, (_, i) => `<Sound index="${i + 1}" url="C:\\s\\${i}.mp3" title="Звук ${i}"/>`).join('')}</Soundlist>`;
  const buf = Buffer.from(big, 'utf8');
  // режем по байтам посреди многобайтных символов, чтобы проверить склейку UTF-8
  const parts = [];
  for (let i = 0; i < buf.length; i += 7001) parts.push(buf.subarray(i, i + 7001));
  await withMock(
    (cmd) => (cmd === 'GetSoundlist()' ? parts : defaultHandler(cmd)),
    async (c) => {
      const xml = await c.getSoundlist();
      assert.equal(xml, big);
    }
  );
});

test('клиент: ответ без XML, пришедший двумя кусками, склеивается по паузе', async () => {
  await withMock(
    (cmd) => (cmd === 'GetVersion()' ? ['1.2', '.3'] : defaultHandler(cmd)),
    async (c) => {
      assert.equal(await c.getVersion(), '1.2.3');
    }
  );
});

test('клиент: запросы идут по очереди, ответы не путаются', async () => {
  await withMock(
    (cmd) => (cmd === 'GetVersion()' ? 'V' : cmd === 'GetRemoteControlVersion()' ? 'RC' : 'R-200'),
    async (c) => {
      const [a, b, d] = await Promise.all([c.getVersion(), c.getRcVersion(), c.isAlive()]);
      assert.deepEqual([a, b, d], ['V', 'RC', true]);
    }
  );
});

test('клиент: Soundpad не запущен — понятная ошибка OFFLINE', async () => {
  const c = new SoundpadClient({ pipePath: tempPipePath() });
  await assert.rejects(() => c.isAlive(), (e) => e.code === 'OFFLINE');
});

test('клиент: нет ответа — TIMEOUT, дальше клиент продолжает работать', async () => {
  let silent = true;
  await withMock(
    (cmd) => (silent && cmd === 'GetVersion()' ? undefined : defaultHandler(cmd)),
    async (c) => {
      await assert.rejects(() => c.getVersion(), (e) => e.code === 'TIMEOUT');
      silent = false;
      assert.equal(await c.getVersion(), '9.9.9'); // переподключение
    },
    { timeoutMs: 150 }
  );
});

test('клиент: разрыв соединения Soundpad — следующий запрос переподключается', async () => {
  await withMock(defaultHandler, async (c, mock) => {
    assert.equal(await c.isAlive(), true);
    mock.dropClients();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await c.isAlive(), true);
  });
});

test('библиотека: loadLibrary собирает категории и «Все звуки»', async () => {
  await withMock(defaultHandler, async (c) => {
    const lib = await loadLibrary(c);
    assert.equal(lib.categories[0].id, 'all');
    assert.equal(lib.categories[0].sounds.length, 5);
    assert.deepEqual(
      lib.categories.slice(1).map((x) => x.id),
      [1, 3, 2]
    );
  });
});

test('библиотека: если звуки не пришли с деревом, подгружаются через GetCategory', async () => {
  const bare = '<Categories><Category index="1" name="A"/><Category index="2" name="B"/></Categories>';
  await withMock(
    (cmd) => {
      if (cmd === 'GetCategories(true, false)') return bare;
      if (cmd === 'GetCategory(1, true, false)') return '<Category index="1" name="A"><Sound index="1" url="a.mp3" title="A1"/></Category>';
      if (cmd === 'GetCategory(2, true, false)') return '<Category index="2" name="B"><Sound index="2" url="b.mp3" title="B1"/></Category>';
      return defaultHandler(cmd);
    },
    async (c, mock) => {
      const lib = await loadLibrary(c);
      assert.deepEqual(
        lib.categories.filter((x) => x.id !== 'all').map((x) => x.sounds.map((s) => s.title)),
        [['A1'], ['B1']]
      );
      assert.ok(mock.commands.includes('GetCategory(1, true, false)'));
    }
  );
});

test('библиотека: ошибка Soundpad при GetCategories не ломает «Все звуки»', async () => {
  await withMock(
    (cmd) => (cmd === 'GetCategories(true, false)' ? 'R-404' : defaultHandler(cmd)),
    async (c) => {
      const lib = await loadLibrary(c);
      assert.equal(lib.categories.length, 1);
      assert.equal(lib.categories[0].id, 'all');
    }
  );
});

test('библиотека: Soundpad выключен — loadLibrary бросает ошибку', async () => {
  const c = new SoundpadClient({ pipePath: tempPipePath() });
  await assert.rejects(() => loadLibrary(c), (e) => e.code === 'OFFLINE');
});

test('служебный: образец XML содержит ожидаемые категории', () => {
  assert.ok(SAMPLE_CATEGORIES.includes('Вложенная'));
});
