import { stringify } from 'query-string';
import {
  fetchUtils,
  GET_LIST,
  GET_ONE,
  GET_MANY,
  GET_MANY_REFERENCE,
  CREATE,
  UPDATE,
  UPDATE_MANY,
  DELETE,
  DELETE_MANY,
  AUTH_LOGIN,
  AUTH_LOGOUT,
  AUTH_ERROR,
  AUTH_CHECK,
  AUTH_GET_PERMISSIONS
} from 'react-admin';

import moment from 'moment';
import isValidObjectID from 'is-mongo-objectid';
import buildUploader from './upload';

const getLoginAction = apiUrl => (username, password) => {
  const request = new Request(`${apiUrl}/auth/local`, {
    method: 'POST',
    body: JSON.stringify({
      identifier: username,
      password
    }),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  })
  return fetch(request)
    .then(response => {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(response.statusText)
      }
      return response.json()
    })
    .then(({ jwt, user }) => {
      localStorage.setItem('strapi_token', jwt)
      localStorage.setItem('strapi_role', user.role.name)
    });
}

const getLogoutAction = apiUrl => params => {
  localStorage.removeItem('strapi_token')
  localStorage.removeItem('strapi_role')
  return Promise.resolve()
}

const getErrorAction = apiUrl => error => {
  const status = error.status;
  if (status === 401 || status === 403) {
    localStorage.removeItem('strapi_token');
    localStorage.removeItem('strapi_role');
    return Promise.reject();
  }
  return Promise.resolve();
}
const getCheckAction = apiUrl => params => {
  return localStorage.getItem('strapi_token') ? Promise.resolve() : Promise.reject()
}

const getGetPermissionsAction = apiUrl => params => {
  const role = localStorage.getItem('strapi_role');
  role ? Promise.resolve(role) : Promise.reject()
}

export const buildAuthProvider3 = apiUrl => {
  return {
    login: ({ username, password }) => getLoginAction(apiUrl)(username, password),
    logout: getLogoutAction(apiUrl),
    checkAuth: getCheckAction(apiUrl),
    checkError: getErrorAction(apiUrl),
    getPermissions: getGetPermissionsAction(apiUrl),
  }
}

export const buildAuthProvider = (apiUrl) => {
  return (type, params) => {
    switch(type) {
      case AUTH_LOGIN:
        const { username, password } = params;
        return getLoginAction(apiUrl)(username, password)
      case AUTH_LOGOUT:
        return getLogoutAction(apiUrl)(params)
      case AUTH_ERROR:
        console.log(params)
        const { error } = params
        return getErrorAction(apiUrl)(error)
      case AUTH_CHECK:
        return getCheckAction(apiUrl)()
      case AUTH_GET_PERMISSIONS:
        return getGetPermissionsAction(apiUrl)()
    }
    return Promise.reject();
  }
}

const getAuthHeaders = () => {
  const authHeaders = {};
  const strapiToken = localStorage.getItem('strapi_token');
  if(strapiToken) {
    authHeaders['Authorization'] = `Bearer ${strapiToken}`;
  }

  return authHeaders;
}

/**
 * Maps react-admin queries to a json-server powered REST API
 *
 * @see https://github.com/typicode/json-server
 * @example
 * GET_LIST     => GET http://my.api.url/posts?_sort=title&_order=ASC&_start=0&_end=24
 * GET_ONE      => GET http://my.api.url/posts/123
 * GET_MANY     => GET http://my.api.url/posts/123, GET http://my.api.url/posts/456, GET http://my.api.url/posts/789
 * UPDATE       => PUT http://my.api.url/posts/123
 * CREATE       => POST http://my.api.url/posts/123
 * DELETE       => DELETE http://my.api.url/posts/123
 */
export default (apiUrl, httpClient = false) => {
  const uploader = buildUploader(apiUrl);
  if(httpClient === false) {
    httpClient = (url, options = {}) => {
      if(!options.headers) {
        options.headers = new Headers(Object.assign({}, getAuthHeaders(), { Accept: 'application/json' }));
      }
      return fetchUtils.fetchJson(url, options);
    }
  }

  const handleUploadForm = async params => {
    let upload = null;
    if(!params.data.files)
      return [];
    for(let index=0; index<params.data.files.length; index++) {
      upload = await uploader(params.data.files[index].rawFile || params.data.files[index]);
      if(upload) {
        params.data.files[index] = Array.isArray(upload) ? upload[0].id : upload.id;
      }
      upload = null;
    }

    return params.data.files;
  }

  const uploadFiles = async params => {
    let upload = null;
    if(params.data) {
      let param, paramName, child;
      let keys = [...Object.keys(params.data)];
      for(let index = 0; index < keys.length; index++) {
        upload = null;
        paramName = keys[index];
        param = params.data[paramName];
        if(param) {
          if (param instanceof File) {
            upload = await uploader(param);
          } else if (typeof param.rawFile !== "undefined" && param.rawFile instanceof File) {
            upload = await uploader(param.rawFile);
          } else if(Array.isArray(param)) {
            for(let i=0; i<param.length; i++) {
              child = param[i];
              if(child instanceof File) {
                upload = await uploader(child);
              } else if (typeof child.rawFile !== "undefined" && child.rawFile instanceof File) {
                upload = await uploader(child.rawFile);
              }

              if(upload) {
                params.data[paramName][i] = Array.isArray(upload) ? upload[0].id : upload.id;
              }
              upload = null;
            }
          }
          if (upload) {
            params.data[paramName] = Array.isArray(upload) ? upload[0].id : upload.id;
          }
        }
      }
    }
  }

  const computeFilters = filters => {
    const { q, ...filter } = filters;
    const flattened = fetchUtils.flattenObject(filter);
    const returner = {};
    Object.keys(flattened).forEach(f => {
      if (moment(flattened[f]).isValid() || !isNaN(flattened[f])) {
        returner[f] = flattened[f];
      } else if(isValidObjectID(flattened[f])) {
        returner[f] = flattened[f];
      } else {
        returner[`${f}_contains`] = flattened[f];
      }
    });

    if (q) returner['_q'] = q;

    return returner;
  }

  /**
   * @param {String} type One of the constants appearing at the top if this file, e.g. 'UPDATE'
   * @param {String} resource Name of the resource to fetch, e.g. 'posts'
   * @param {Object} params The data request params, depending on the type
   * @returns {Object} { url, options } The HTTP request parameters
   */
  const convertDataRequestToHTTP = async (type, resource, params) => {
    let url = '';
    const options = {};
    switch (type) {
      case GET_LIST: {
        const { page, perPage } = params.pagination;
        const { field, order } = params.sort;
        const filters = computeFilters(params.filter);
        const query = {
          ...filters,
          _sort: field + ':' + order,
          _start: (page - 1) * perPage,
          _limit: perPage,
        };
        url = `${apiUrl}/${resource}?${stringify(query)}`;
        break;
      }
      case GET_ONE:
        url = `${apiUrl}/${resource}/${params.id}`;
        break;
      case GET_MANY_REFERENCE: {
        const { page, perPage } = params.pagination;
        const { field, order } = params.sort;
        const query = {
          ...fetchUtils.flattenObject(params.filter),
          [params.target]: params.id,
          _sort: field + ':' + order,
          _start: (page - 1) * perPage,
          _limit: perPage,
        };
        url = `${apiUrl}/${resource}?${stringify(query)}`;
        break;
      }
      case UPDATE:
        url = `${apiUrl}/${resource}/${params.id}`;
        options.method = 'PUT';
        await uploadFiles(params);
        options.body = JSON.stringify(params.data);
        break;
      case CREATE:
        url = `${apiUrl}/${resource}`;
        options.method = 'POST';
        await uploadFiles(params);
        options.body = JSON.stringify(params.data);
        break;
      case DELETE:
        url = `${apiUrl}/${resource}/${params.id}`;
        options.method = 'DELETE';
        break;
      case GET_MANY: {
        const query = {
          _id_in: params.ids.map(id => typeof id === 'string' ? id : id.id),
        };
        url = `${apiUrl}/${resource}?${stringify(query)}`;
        break;
      }
      default:
        throw new Error(`Unsupported fetch action type ${type}`);
    }
    return { url, options };
  };

  /**
   * @param {Object} response HTTP response from fetch()
   * @param {String} type One of the constants appearing at the top if this file, e.g. 'UPDATE'
   * @param {String} resource Name of the resource to fetch, e.g. 'posts'
   * @param {Object} params The data request params, depending on the type
   * @returns {Object} Data response
   */
  const convertHTTPResponse = (response, type, resource, params) => {
    const { headers, json } = response;
    switch (type) {
      case GET_LIST:
      case GET_MANY_REFERENCE:
        const filters = computeFilters(params.filter);
        return httpClient(`${apiUrl}/${resource}/count?${stringify(filters)}`, {
          method: 'GET'
        }).then(response => {
          return {
            data: json,
            total: response.json.count || response.json //Some endpoints (like the upload plugin one) return total as a property "count"
          };
        });
      case CREATE:
        return { data: { ...json, id: json.id } };
      default:
        return { data: json };
    }
  };

  /**
   * @param {string} type Request type, e.g GET_LIST
   * @param {string} resource Resource name, e.g. "posts"
   * @param {Object} payload Request parameters. Depends on the request type
   * @returns {Promise} the Promise for a data response
   */
  return async (type, resource, params) => {
    // json-server doesn't handle filters on UPDATE route, so we fallback to calling UPDATE n times instead
    if (type === UPDATE_MANY) {
      return Promise.all(
        params.ids.map(async id => { 
          await uploadFiles(params);
          return httpClient(`${apiUrl}/${resource}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(params.data),
          })
        })
      ).then(responses => ({
        data: responses.map(response => response.json),
      }));
    }
    // json-server doesn't handle filters on DELETE route, so we fallback to calling DELETE n times instead
    if (type === DELETE_MANY) {
      return Promise.all(
        params.ids.map(id =>
          httpClient(`${apiUrl}/${resource}/${id}`, {
            method: 'DELETE',
          })
        )
      ).then(responses => ({
        data: responses.map(response => response.json),
      }));
    }
    if(resource === 'upload' && type === CREATE) {
      const upload = handleUploadForm(params);
      return {
        data: {
          files: upload,
          id: null
        }
      }
    }
    if(resource === 'upload/files') {
      const { filter = {} } = params;
      filter['basepath'] = 0;
      params.filter = filter;
    }
    const { url, options } = await convertDataRequestToHTTP(
      type,
      resource,
      params
    );
    return httpClient(url, options).then(response =>
      convertHTTPResponse(response, type, resource, params)
    );
  };
};
