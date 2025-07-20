import axios, { AxiosInstance } from 'axios';
import type { ConfluenceConfig } from '../types/index.js';

/**
 * Create Axios instance for Confluence API with proper authentication
 */
export function createConfluenceApiInstance(config: ConfluenceConfig): AxiosInstance {
  const baseURL = `https://${config.domain}/wiki/api/v2`;
  
  // Create base configuration
  const axiosConfig: any = {
    baseURL,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  };
  
  // Add authentication headers based on type
  if (config.auth.type === 'oauth2') {
    axiosConfig.headers['Authorization'] = `Bearer ${config.auth.accessToken}`;
  } else {
    // Basic auth
    const authString = Buffer.from(`${config.auth.email}:${config.auth.apiToken}`).toString('base64');
    axiosConfig.headers['Authorization'] = `Basic ${authString}`;
  }
  
  return axios.create(axiosConfig);
}

/**
 * Create Axios instance for Confluence API v1 (for endpoints not yet in v2)
 */
export function createConfluenceApiV1Instance(config: ConfluenceConfig): AxiosInstance {
  const baseURL = `https://${config.domain}/wiki/rest/api`;
  
  // Create base configuration
  const axiosConfig: any = {
    baseURL,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  };
  
  // Add authentication headers based on type
  if (config.auth.type === 'oauth2') {
    axiosConfig.headers['Authorization'] = `Bearer ${config.auth.accessToken}`;
  } else {
    // Basic auth
    const authString = Buffer.from(`${config.auth.email}:${config.auth.apiToken}`).toString('base64');
    axiosConfig.headers['Authorization'] = `Basic ${authString}`;
  }
  
  return axios.create(axiosConfig);
}