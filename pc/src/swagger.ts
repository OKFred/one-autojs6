import swaggerJSDoc from 'swagger-jsdoc';
import { swaggerUI } from '@hono/swagger-ui';
import { Hono } from 'hono';

const options = {
  definition: {
    openapi: '3.1.0',
    info: {
      title: 'one-autojs6 API',
      version: '1.0.0',
      description: '基于 MQTT + HonoJS + Auto.js v6 的任务调度控制系统接口文档',
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3000}`,
      },
    ],
  },
  // 扫描包含 swagger 注释的文件路径
  apis: ['./src/controller/*.ts', './pc/src/controller/*.ts'], 
};

const swaggerSpec = swaggerJSDoc(options);

/**
 * 注册 Swagger UI 路由与 API Spec JSON 路由到 Hono App 实例。
 * 
 * @param app - Hono App 实例
 */
export function registerSwagger(app: Hono) {
  app.get('/swagger', swaggerUI({ url: '/api-spec' }));
  app.get('/api-spec', (c) => c.json(swaggerSpec));
}
