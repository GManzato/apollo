import { Meteor } from 'meteor/meteor';
import { db } from 'meteor/cultofcoders:grapher';
import { WebApp } from 'meteor/webapp';
import { ApolloServer } from 'apollo-server-express';
import { SubscriptionServer } from 'subscriptions-transport-ws';
import { execute, subscribe } from 'graphql';


import { getSchema } from 'graphql-load';
import { makeExecutableSchema } from 'graphql-tools';
import { parse as urlParse } from 'url';

import { AUTH_TOKEN_KEY } from '../constants';
import defaultSchemaDirectives from './directives';
import { getUserForContext } from './core/users';

/**
 *
 * @param {*} apolloConfig Options https://www.apollographql.com/docs/apollo-server/api/apollo-server.html#constructor-options-lt-ApolloServer-gt
 * @param {MeteorApolloConfig} meteorApolloConfig
 */
export default function initialize(apolloConfig = {}, meteorApolloConfig = {}) {
  meteorApolloConfig = Object.assign(
    {
      gui: Meteor.isDevelopment,
      middlewares: [],
      userFields: {
        _id: 1,
        roles: 1,
        username: 1,
        emails: 1,
      },
    },
    meteorApolloConfig,
  );

  const { typeDefs, resolvers } = getSchema();

  const initialApolloConfig = Object.assign({}, apolloConfig);
  apolloConfig = {
    introspection: Meteor.isDevelopment,
    debug: Meteor.isDevelopment,
    path: '/graphql',
    formatError: e => ({
      message: e.message,
      locations: e.locations,
      path: e.path,
    }),
    ...initialApolloConfig,
    schema: makeExecutableSchema({
      typeDefs,
      resolvers,
      allowUndefinedInResolve: true,
      schemaDirectives: {
        ...defaultSchemaDirectives,
        ...(initialApolloConfig.schemaDirectives
          ? initialApolloConfig.schemaDirectives
          : []),
      },
    }),
    context: getContextCreator(meteorApolloConfig, initialApolloConfig.context),
    // subscriptions: getSubscriptionConfig(meteorApolloConfig),
  };

  const server = new ApolloServer(apolloConfig);

  server.applyMiddleware({
    app: WebApp.connectHandlers,
    gui: meteorApolloConfig.gui,
  });

  // server.installSubscriptionHandlers(WebApp.httpServer);

  meteorApolloConfig.middlewares.forEach((middleware) => {
    WebApp.connectHandlers.use('/graphql', middleware);
  });


  const subscriptionServer = SubscriptionServer.create(
    {
      schema: makeExecutableSchema({
        typeDefs,
        resolvers,
        allowUndefinedInResolve: true,
        schemaDirectives: {
          ...defaultSchemaDirectives,
          ...(initialApolloConfig.schemaDirectives
            ? initialApolloConfig.schemaDirectives
            : []),
        },
      }),
      execute,
      subscribe,
      onConnect: (connectionParams, webSocket) => ({ db }),
    },
    {
      noServer: true,
    },
  );

  const { wsServer } = subscriptionServer;

  const websocketFallback = (req, socket, head) => {
    if (socket.destroy) {
      socket.destroy();
    }
  }

  const upgradeHandler = (req, socket, head) => {
    const { pathname } = urlParse(req.url);

    if (pathname === '/graphql') {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit('connection', ws, req);
      });
    } else if (pathname.startsWith('/sockjs')) {
      // Don't do anything, this is meteor socket.
    } else {
      websocketFallback(req, socket, head);
    }
  };
  WebApp.httpServer.on('upgrade', upgradeHandler);


  // We are doing this work-around because Playground sets headers and WebApp also sets headers
  // Resulting into a conflict and a server side exception of "Headers already sent"
  WebApp.connectHandlers.use('/graphql', (req, res) => {
    if (req.method === 'GET') {
      res.end();
    }
  });

  return {
    server,
  };
}

function getContextCreator(meteorApolloConfig, defaultContextResolver) {
  return async function getContext({ req, connection }) {
    const defaultContext = defaultContextResolver
      ? await defaultContextResolver({ req, connection })
      : {};

    Object.assign(defaultContext, { db });

    if (connection) {
      return {
        ...defaultContext,
        ...connection.context,
      };
    }
    let userContext = {};
    if (Package['accounts-base']) {
      const loginToken =
          req.headers['meteor-login-token'] ||
          req.cookies['meteor-login-token'];
      userContext = await getUserForContext(
        loginToken,
        meteorApolloConfig.userFields,
      );
    }

    return {
      ...defaultContext,
      ...userContext,
    };
  };
}

function getSubscriptionConfig(meteorApolloConfig) {
  return {
    onConnect: async (connectionParams, webSocket, context) => {
      const loginToken = connectionParams[AUTH_TOKEN_KEY];

      return new Promise((resolve, reject) => {
        if (loginToken) {
          const userContext = getUserForContext(
            loginToken,
            meteorApolloConfig.userFields,
          ).then((userContext) => {
            resolve(userContext);
          });
        } else {
          resolve({});
        }
      });
    },
  };
}
