import { createHash } from 'crypto'
import { parse } from 'dotenv'
import { hashElement } from 'folder-hash'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as k8s from '@pulumi/kubernetes'
import { Input, Resource } from '@pulumi/pulumi'
import { buildAndPushImage, Config, hasTag } from './index'

export interface ApiConfig {
  enableDatadogLogs?: boolean
}

// creates a hash of the content included in the final build image
const getHash = async (asset: string): Promise<string> => {
  const hash = createHash('sha1')

  // hash root level unchained files
  const { hash: unchainedHash } = await hashElement('../../../', {
    folders: { exclude: ['.*', '*'] },
    files: { include: ['package.json', 'lerna.json'] },
  })
  hash.update(unchainedHash)

  // hash contents of packages
  const { hash: packagesHash } = await hashElement('../../../packages', {
    folders: { include: ['**'], exclude: ['.*', 'dist', 'node_modules', 'pulumi'] },
    files: { include: ['*.ts', '*.json', 'Dockerfile'] },
  })
  hash.update(packagesHash)

  // hash contents of common-api
  const { hash: commonApiHash } = await hashElement('../../common/api', {
    folders: { include: ['**'], exclude: ['.*', 'dist', 'node_modules', 'pulumi'] },
    files: { include: ['*.ts', '*.json', 'Dockerfile'] },
  })
  hash.update(commonApiHash)

  // hash contents of asset-api
  const { hash: apiHash } = await hashElement(`../../${asset}/api`, {
    folders: { include: ['**'], exclude: ['.*', 'dist', 'node_modules', 'pulumi'] },
    files: { include: ['*.ts', '*.json', 'Dockerfile'] },
  })
  hash.update(apiHash)

  return hash.digest('hex')
}

export async function deployApi(
  app: string,
  asset: string,
  provider: k8s.Provider,
  namespace: string,
  config: Pick<Config, 'api' | 'dockerhub' | 'isLocal' | 'rootDomainName'>,
  deployDependencies: Input<Array<Resource>> = []
): Promise<k8s.apps.v1.Deployment | undefined> {
  if (config.api === undefined) return

  const tier = 'api'
  const labels = { app, asset, tier }
  const name = `${asset}-${tier}`

  let imageName = 'mhart/alpine-node:14.16.0' // local dev image
  if (!config.isLocal) {
    const repositoryName = `${app}-${asset}-${tier}`
    const tag = await getHash(asset)

    imageName = `shapeshiftdao/${repositoryName}:${tag}` // default public image
    if (config.dockerhub) {
      const image = `${config.dockerhub.username}/${repositoryName}`
      const baseImageName = `${config.dockerhub.username}/unchained-base:latest`

      imageName = `${image}:${tag}` // configured dockerhub image

      if (!(await hasTag(image, tag))) {
        await buildAndPushImage({
          image,
          context: `../../${asset}/api`,
          auth: {
            password: config.dockerhub.password,
            username: config.dockerhub.username,
            server: config.dockerhub.server,
          },
          buildArgs: {
            BUILDKIT_INLINE_CACHE: '1',
            BASE_IMAGE: baseImageName, // associated base image for dockerhub user expected to exist
          },
          env: { DOCKER_BUILDKIT: '1' },
          tags: [tag],
          cacheFroms: [`${image}:${tag}`, `${image}:latest`, baseImageName],
        })
      }
    }
  }

  const service = new k8s.core.v1.Service(
    `${name}-svc`,
    {
      metadata: {
        name: `${name}-svc`,
        namespace: namespace,
        labels: labels,
      },
      spec: {
        selector: labels,
        ...(config.isLocal
          ? {
              ports: [{ port: 3000, protocol: 'TCP', name: 'http', nodePort: 31300 }],
              type: 'NodePort',
            }
          : {
              ports: [{ port: 3000, protocol: 'TCP', name: 'http' }],
              type: 'ClusterIP',
            }),
      },
    },
    { provider, deleteBeforeReplace: true }
  )

  if (config.rootDomainName) {
    const secretName = `${name}-cert-secret`

    new k8s.apiextensions.CustomResource(
      `${name}-cert`,
      {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
        metadata: {
          namespace: namespace,
          labels: labels,
        },
        spec: {
          secretName: secretName,
          duration: '2160h',
          renewBefore: '360h',
          isCA: false,
          privateKey: {
            algorithm: 'RSA',
            encoding: 'PKCS1',
            size: 2048,
          },
          dnsNames: [`api.${asset}.${config.rootDomainName}`],
          issuerRef: {
            name: 'lets-encrypt',
            kind: 'ClusterIssuer',
            group: 'cert-manager.io',
          },
        },
      },
      { provider }
    )

    const additionalRootDomainName = process.env.ADDITIONAL_ROOT_DOMAIN_NAME
    const extraMatch = additionalRootDomainName ? ` || Host(\`api.${asset}.${additionalRootDomainName}\`)` : ''

    new k8s.apiextensions.CustomResource(
      `${name}-ingressroute`,
      {
        apiVersion: 'traefik.containo.us/v1alpha1',
        kind: 'IngressRoute',
        metadata: {
          namespace: namespace,
          labels: labels,
        },
        spec: {
          entryPoints: ['web', 'websecure'],
          routes: [
            {
              match: `Host(\`api.${asset}.${config.rootDomainName}\`)` + extraMatch,
              kind: 'Rule',
              services: [
                {
                  kind: 'Service',
                  name: service.metadata.name,
                  port: service.spec.ports[0].port,
                  namespace: service.metadata.namespace,
                },
              ],
            },
          ],
          tls: {
            secretName: secretName,
            domains: [{ main: `api.${asset}.${config.rootDomainName}` }],
          },
        },
      },
      { provider }
    )

    new k8s.networking.v1.Ingress(
      `${name}-ingress`,
      {
        metadata: {
          namespace: namespace,
          labels: labels,
        },
        spec: {
          rules: [{ host: `api.${asset}.${config.rootDomainName}` }],
        },
      },
      { provider }
    )
  }

  const secretEnvs = Object.keys(parse(readFileSync('../sample.env'))).map<k8s.types.input.core.v1.EnvVar>((key) => ({
    name: key,
    valueFrom: { secretKeyRef: { name: asset, key: key } },
  }))

  const datadogAnnotation = config.api.enableDatadogLogs
    ? {
        [`ad.datadoghq.com/${tier}.logs`]: `[{"source": "${app}", "service": "${name}"}]`,
      }
    : {}

  const podSpec: k8s.types.input.core.v1.PodTemplateSpec = {
    metadata: {
      annotations: { ...datadogAnnotation },
      namespace: namespace,
      labels: labels,
    },
    spec: {
      containers: [
        {
          name: tier,
          image: imageName,
          ports: [{ containerPort: 3000, name: 'http' }],
          env: [...secretEnvs],
          command: config.isLocal ? ['sh', '-c', 'yarn nodemon'] : ['node', `dist/${asset}/api/src/index.js`],
          readinessProbe: {
            httpGet: { path: '/health', port: 3000 },
            initialDelaySeconds: 10,
            periodSeconds: 5,
            failureThreshold: 3,
            successThreshold: 1,
          },
          livenessProbe: {
            httpGet: { path: '/health', port: 3000 },
            initialDelaySeconds: 30,
            periodSeconds: 5,
            failureThreshold: 3,
            successThreshold: 1,
          },
          ...(config.isLocal && {
            volumeMounts: [{ name: 'app', mountPath: '/app' }],
            workingDir: `/app/coinstacks/${asset}/api`,
          }),
        },
      ],
      ...(config.isLocal && {
        volumes: [{ name: 'app', hostPath: { path: join(__dirname, '../../../../') } }],
      }),
    },
  }

  return new k8s.apps.v1.Deployment(
    name,
    {
      metadata: {
        namespace: namespace,
      },
      spec: {
        selector: { matchLabels: labels },
        replicas: 1,
        template: podSpec,
      },
    },
    { provider, dependsOn: deployDependencies }
  )
}
