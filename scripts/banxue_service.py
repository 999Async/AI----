#!/usr/bin/env python3
"""Install and manage the local-only Banxue service on macOS."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen


LABEL = 'com.banxue.local-service'
PORT = 4178
PROJECT = Path(__file__).resolve().parent.parent
AGENT = Path.home() / 'Library' / 'LaunchAgents' / f'{LABEL}.plist'
LOG_DIR = Path.home() / 'Library' / 'Logs' / 'Banxue'
APP_DIR = Path.home() / 'Library' / 'Application Support' / 'Banxue'
RUNTIME = APP_DIR / 'runtime'
DATA_DIR = APP_DIR / 'data'


def find_codex():
    candidates = [
        os.environ.get('BANXUE_CODEX_BIN'),
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        shutil.which('codex'),
        str(Path.home() / '.npm-global' / 'bin' / 'codex'),
    ]
    return next((Path(value).resolve() for value in candidates if value and Path(value).is_file()), None)


def build_config(project, python, codex, log_path, data_dir=None):
    data_dir = data_dir or project / '.banxue'
    path = ':'.join(dict.fromkeys([str(codex.parent), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']))
    return {
        'Label': LABEL,
        'ProgramArguments': [str(python), str(project / 'backend' / 'server.py'),
                             '--data-dir', str(data_dir), '--port', str(PORT)],
        'WorkingDirectory': str(project),
        'EnvironmentVariables': {'BANXUE_CODEX_BIN': str(codex), 'PATH': path},
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 5,
        'ProcessType': 'Background',
        'StandardOutPath': str(log_path),
        'StandardErrorPath': str(log_path.with_name('service-error.log')),
        'Umask': 0o077,
    }


def launchctl(*args, check=True):
    return subprocess.run(['/bin/launchctl', *args], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def domain():
    return f'gui/{os.getuid()}'


def health(timeout=1):
    try:
        with urlopen(f'http://127.0.0.1:{PORT}/api/health', timeout=timeout) as response:
            return response.status == 200
    except OSError:
        return False


def write_agent(config):
    AGENT.parent.mkdir(parents=True, exist_ok=True)
    payload = plistlib.dumps(config, fmt=plistlib.FMT_XML, sort_keys=False)
    with tempfile.NamedTemporaryFile(dir=AGENT.parent, prefix=LABEL, delete=False) as handle:
        handle.write(payload)
        temporary = Path(handle.name)
    temporary.chmod(0o600)
    temporary.replace(AGENT)


def prepare_runtime(source):
    APP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    ignore = shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store', 'test_*.py')
    shutil.copytree(source / 'backend', RUNTIME / 'backend', dirs_exist_ok=True, ignore=ignore)
    shutil.copytree(source / 'prototype', RUNTIME / 'prototype', dirs_exist_ok=True, ignore=ignore)
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    source_db = source / '.banxue' / 'homework.sqlite3'
    target_db = DATA_DIR / 'homework.sqlite3'
    if source_db.is_file() and not target_db.exists():
        with sqlite3.connect(source_db) as origin, sqlite3.connect(target_db) as target:
            origin.backup(target)
    return RUNTIME


def install():
    python = Path(sys.executable).resolve()
    codex = find_codex()
    server = PROJECT / 'backend' / 'server.py'
    if not server.is_file():
        raise SystemExit(f'未找到服务入口：{server}')
    if codex is None:
        raise SystemExit('未找到 Codex CLI，请先安装并完成 codex login。')
    launchctl('bootout', domain(), str(AGENT), check=False)
    runtime = prepare_runtime(PROJECT)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    write_agent(build_config(runtime, python, codex, LOG_DIR / 'service.log', DATA_DIR))
    launchctl('bootstrap', domain(), str(AGENT))
    launchctl('enable', f'{domain()}/{LABEL}')
    launchctl('kickstart', '-k', f'{domain()}/{LABEL}')
    for _ in range(30):
        if health():
            print(f'伴学服务已安装并运行：http://127.0.0.1:{PORT}')
            return
        time.sleep(.2)
    raise SystemExit(f'守护进程已安装，但健康检查未通过。查看 {LOG_DIR / "service-error.log"}')


def status():
    loaded = launchctl('print', f'{domain()}/{LABEL}', check=False).returncode == 0
    print(f'守护进程：{"running" if loaded else "not loaded"}')
    print(f'健康检查：{"ok" if health() else "unavailable"}')
    print(f'访问地址：http://127.0.0.1:{PORT}')
    return 0 if loaded and health() else 1


def uninstall():
    launchctl('bootout', domain(), str(AGENT), check=False)
    if AGENT.exists():
        AGENT.unlink()
    print('伴学守护进程已移除，学习数据保留。')


def main():
    parser = argparse.ArgumentParser(description='管理伴学本地服务')
    parser.add_argument('command', choices=('install', 'status', 'uninstall'))
    args = parser.parse_args()
    if args.command == 'install':
        install()
        return 0
    if args.command == 'status':
        return status()
    uninstall()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
