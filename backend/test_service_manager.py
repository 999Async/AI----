import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parent.parent / 'scripts' / 'banxue_service.py'


class ServiceManagerTest(unittest.TestCase):
    def module(self):
        spec = importlib.util.spec_from_file_location('banxue_service', MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_launch_agent_keeps_the_integrated_server_alive(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'backend').mkdir()
            (root / 'backend' / 'server.py').write_text('pass')
            config = module.build_config(root, Path('/opt/python3'), Path('/opt/codex'), Path('/tmp/banxue.log'))
        self.assertEqual(config['Label'], module.LABEL)
        self.assertTrue(config['RunAtLoad'])
        self.assertTrue(config['KeepAlive'])
        self.assertEqual(config['ProgramArguments'][-2:], ['--port', str(module.PORT)])
        self.assertEqual(config['EnvironmentVariables']['BANXUE_CODEX_BIN'], '/opt/codex')
        self.assertEqual(config['WorkingDirectory'], str(root))

    def test_runtime_copy_uses_application_data_without_copying_test_cache(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            runtime = root / 'runtime'
            data = root / 'data'
            (source / 'backend' / '__pycache__').mkdir(parents=True)
            (source / 'prototype').mkdir()
            (source / 'backend' / 'server.py').write_text('server')
            (source / 'backend' / 'test_server.py').write_text('test')
            (source / 'backend' / '__pycache__' / 'server.pyc').write_bytes(b'cache')
            (source / 'prototype' / 'index.html').write_text('app')
            original_runtime, original_data, original_app = module.RUNTIME, module.DATA_DIR, module.APP_DIR
            module.RUNTIME, module.DATA_DIR, module.APP_DIR = runtime, data, root / 'app'
            try:
                module.prepare_runtime(source)
            finally:
                module.RUNTIME, module.DATA_DIR, module.APP_DIR = original_runtime, original_data, original_app
            self.assertEqual((runtime / 'backend' / 'server.py').read_text(), 'server')
            self.assertEqual((runtime / 'prototype' / 'index.html').read_text(), 'app')
            self.assertFalse((runtime / 'backend' / 'test_server.py').exists())
            self.assertFalse((runtime / 'backend' / '__pycache__').exists())


if __name__ == '__main__':
    unittest.main()
