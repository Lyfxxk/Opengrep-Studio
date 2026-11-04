pipeline {
  agent any

  options {
    buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '10'))
    disableConcurrentBuilds()
    timeout(time: 90, unit: 'MINUTES')
  }

  parameters {
    booleanParam(name: 'RUN_E2E', defaultValue: true, description: '运行真实引擎端到端回归；首次执行需联网下载约 50MB 引擎并做 SHA256 校验')
    booleanParam(name: 'BUILD_DOCKER', defaultValue: false, description: '构建镜像并做容器冒烟；节点需安装 docker，否则请保持关闭')
  }

  environment {
    NODE_MIN_VERSION = '22.12.0'
    npm_config_audit = 'false'
    npm_config_fund = 'false'
  }

  stages {
    stage('工具链自检') {
      steps {
        sh '''
          node -e '
            const need = process.env.NODE_MIN_VERSION.split(".").map(Number);
            const cur = process.versions.node.split(".").map(Number);
            const lower = cur[0] < need[0]
              || (cur[0] === need[0] && cur[1] < need[1])
              || (cur[0] === need[0] && cur[1] === need[1] && cur[2] < need[2]);
            if (lower) {
              console.error(`[jenkins] 当前 Node ${process.versions.node} 低于要求的 ${process.env.NODE_MIN_VERSION}：请在该节点安装 Node 22.12 及以上（或按 .nvmrc 安装 26）后重试`);
              process.exit(1);
            }
            console.log(`[jenkins] Node ${process.versions.node} 满足 >= ${process.env.NODE_MIN_VERSION}`);
          '
          node -v
          npm -v
          git --version
        '''
      }
    }

    stage('依赖安装') {
      steps {
        sh '''
          npm --prefix server ci
          npm --prefix code ci
        '''
      }
    }

    stage('后端类型检查与单元测试') {
      steps {
        sh '''
          npm --prefix server run typecheck
          npm --prefix server test
        '''
      }
    }

    stage('i18n 资源一致性') {
      steps {
        sh '''
          npm --prefix server run i18n:check
          npm run test-packs
        '''
      }
    }

    stage('前端 lint 与构建') {
      steps {
        sh '''
          npm --prefix code run lint
          npm --prefix code run build
        '''
      }
    }

    stage('扫描引擎准备') {
      when { expression { params.RUN_E2E != false } }
      steps {
        retry(2) {
          sh 'npm run setup:engine'
        }
      }
    }

    stage('端到端回归') {
      when { expression { params.RUN_E2E != false } }
      steps {
        sh '''
          set -euo pipefail

          health() {
            node -e "fetch('http://127.0.0.1:' + process.argv[1] + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$1"
          }

          TMP="${WORKSPACE_TMP:-${WORKSPACE}/.tmp}"
          DATA_DIR="$TMP/e2e-data"
          CUSTOM_RULES_DIR="$TMP/e2e-rules-custom"
          rm -rf "$DATA_DIR" "$CUSTOM_RULES_DIR"
          mkdir -p "$DATA_DIR" "$CUSTOM_RULES_DIR"

          PORT="$(node -e "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });")"
          export HOST=127.0.0.1 PORT DATA_DIR CUSTOM_RULES_DIR

          (
            cd server && exec node --import tsx src/index.ts
          ) > server.log 2>&1 &
          SERVER_PID=$!

          cleanup() {
            if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2> /dev/null; then
              kill -TERM "$SERVER_PID" 2> /dev/null || true
              for _ in $(seq 1 15); do
                kill -0 "$SERVER_PID" 2> /dev/null || break
                sleep 1
              done
              kill -KILL "$SERVER_PID" 2> /dev/null || true
            fi
          }
          trap cleanup EXIT

          ready=0
          for _ in $(seq 1 60); do
            if health "$PORT"; then
              ready=1
              break
            fi
            if ! kill -0 "$SERVER_PID" 2> /dev/null; then
              echo "[jenkins] 后端进程提前退出，日志尾部："
              tail -n 80 server.log || true
              exit 1
            fi
            sleep 2
          done

          if [ "$ready" -ne 1 ]; then
            echo "[jenkins] 后端 120 秒内未通过 /api/health，日志尾部："
            tail -n 80 server.log || true
            exit 1
          fi

          echo "[jenkins] 后端就绪：http://127.0.0.1:${PORT}"
          BASE_URL="http://127.0.0.1:${PORT}" npm run e2e 2>&1 | tee e2e.log
        '''
      }
    }

    stage('镜像构建与冒烟') {
      when { expression { params.BUILD_DOCKER == true } }
      steps {
        sh '''
          set -euo pipefail

          health() {
            node -e "fetch('http://127.0.0.1:' + process.argv[1] + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$1"
          }

          IMAGE="opengrep-studio:ci-${BUILD_NUMBER}"
          NAME="opengrep-studio-smoke-${BUILD_NUMBER}"

          cleanup() {
            docker rm -f "$NAME" > /dev/null 2>&1 || true
            docker rmi -f "$IMAGE" > /dev/null 2>&1 || true
          }
          trap cleanup EXIT

          docker build -t "$IMAGE" .

          PORT="$(node -e "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });")"
          docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8787" "$IMAGE" > /dev/null

          ready=0
          for _ in $(seq 1 45); do
            if health "$PORT"; then
              ready=1
              break
            fi
            if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2> /dev/null || echo false)" != "true" ]; then
              break
            fi
            sleep 2
          done

          if [ "$ready" -ne 1 ]; then
            echo "[jenkins] 容器冒烟失败，容器日志："
            docker logs "$NAME" || true
            exit 1
          fi

          echo "[jenkins] 容器冒烟通过：http://127.0.0.1:${PORT}/api/health"
        '''
      }
    }
  }

  post {
    success {
      echo '构建通过：后端类型检查/单测/i18n/规则包、前端 lint/构建均已通过，按参数启用的真实引擎 E2E 与镜像冒烟也全部通过。'
    }
    failure {
      echo '构建失败：请查看失败 stage 的输出，后端启动日志与 E2E 日志已归档为 server.log / e2e.log。'
    }
    always {
      archiveArtifacts artifacts: 'e2e.log, server.log', allowEmptyArchive: true, fingerprint: true
    }
  }
}
