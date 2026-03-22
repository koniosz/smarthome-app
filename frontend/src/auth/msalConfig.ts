import { PublicClientApplication, Configuration } from '@azure/msal-browser'

const tenantId = import.meta.env.VITE_AZURE_TENANT_ID || ''
const clientId = import.meta.env.VITE_AZURE_CLIENT_ID || ''

export const azureConfigured = Boolean(tenantId && clientId)

const msalConfig: Configuration = {
  auth: {
    clientId: clientId || 'not-configured',
    authority: `https://login.microsoftonline.com/${tenantId || 'common'}`,
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
  },
}

export const msalInstance = new PublicClientApplication(msalConfig)

export const loginRequest = {
  scopes: ['openid', 'profile', 'email'],
}
