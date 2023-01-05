import {Env} from ".";

// Assume the access token will live longer than the lifetime of this object
export class GoogleAuthentication {
  constructor(_accessToken: string) { this.accessToken = _accessToken; }
  private accessToken: string;

  signRequest<T>(request: RequestInit<T> = {}): RequestInit<T> {
    request.headers = {"Authorization" : `Bearer ${this.accessToken}`};
    return request;
  }
};

interface RefreshTokenResponse {
  access_token: string
  expires_in: number
  // scope
  // token type
}

async function authenticateFrom(todoistUserId: string,
                                env: Env): Promise<GoogleAuthentication|null> {
  const accessToken = await env.KV.get(`access-token:${todoistUserId}`);
  if (accessToken) {
    console.log("Obtained authentication token from cache");
    return new GoogleAuthentication(accessToken);
  }

  console.debug("Obtaining authentication token from refreshToken");
  const refreshToken = await env.KV.get(`refresh-token:${todoistUserId}`);
  if (refreshToken == null) {
    console.debug("Refresh Token not found");
    return null;
  }

  const payload = {
    "client_id" : env.CLIENT_ID,
    "client_secret" : env.CLIENT_SECRET,
    "refresh_token" : refreshToken,
    "grant_type" : "refresh_token",
  };

  let payloadStr;
  {
    let payloadKVs = [];
    for (const kv of Object.entries(payload)) {
      payloadKVs.push(kv.join("="));
    }
    payloadStr = payloadKVs.join("&");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method : "POST",
    headers : {"Content-Type" : "application/x-www-form-urlencoded"},
    body : payloadStr,
  });

  if (!response.ok) {
    console.error("Cannot obtain refresh token", response.status);
    return null;
  }

  const ack: RefreshTokenResponse = await response.json();
  env.KV.put(`access-token:${todoistUserId}`, ack.access_token,
             {expirationTtl : ack.expires_in})

  console.log("Obtained authentication token from refresh token");
  return new GoogleAuthentication(ack.access_token);
}

export interface GoogleTask {
  completed: string;
  deleted: boolean;
  due?: string|null;
  etag: string;
  hidden: boolean;
  id: string;
  kind: string;
  links: Array<{description?: string; link?: string; type?: string;}>;
  notes?: string|null;
  parent?: string|null;
  position: string;
  selfLink: string;
  status: string;
  title: string;
  updated: string;
}

export interface GoogleTaskInsert {
  completed?: string|null;
  deleted?: boolean|null;
  due?: string|null;
  etag?: string|null;
  hidden?: boolean|null;
  id?: string|null;
  kind?: string|null;
  links?: Array<{description?: string; link?: string; type?: string;}>|null;
  notes?: string|null;
  parent?: string|null;
  position?: string|null;
  selfLink?: string|null;
  status?: string|null;
  title?: string|null;
  updated?: string|null;
}

interface FailResponse {
  error: {
    code: string,
    message: string,
    // details.
  }
}

export class TaskApi {
  constructor(_listId: string, _auth: GoogleAuthentication) {
    this.listId = _listId;
    this.auth = _auth;
  }
  private listId: string;
  private auth: GoogleAuthentication;

  private urlOf(taskId: string): string {
    return `https://tasks.googleapis.com/tasks/v1/lists/${this.listId}/tasks/${
        taskId}`;
  }

  private async handleFailedResponse(fetchResponse: Response): Promise<never> {
    const response: FailResponse = await fetchResponse.json();
    console.error(response.error.code, response.error.message,
                  JSON.stringify(response.error));
    throw response.error;
  }

  private async handleResponse(fetchResponse: Response): Promise<GoogleTask> {
    if (fetchResponse.ok) {
      const response: GoogleTask = await fetchResponse.json();
      console.log(JSON.stringify(response));
      return response;
    } else {
      return await this.handleFailedResponse(fetchResponse);
    }
  }

  async retriveTask(taskId: string): Promise<GoogleTask> {
    const fetchResponse =
        await fetch(this.urlOf(taskId), this.auth.signRequest());
    return this.handleResponse(fetchResponse);
  }

  async updateTask(taskId: string,
                   updated: GoogleTaskInsert): Promise<GoogleTask> {
    updated.id = taskId;
    const fetchResponse =
        await fetch(this.urlOf(taskId),
                    this.auth.signRequest(
                        {method : "PUT", body : JSON.stringify(updated)}));
    return this.handleResponse(fetchResponse);
  }

  async deleteTask(taskId: string) {
    const fetchResponse =
        await fetch(this.urlOf(taskId), this.auth.signRequest());
    if (!fetchResponse.ok)
      await this.handleFailedResponse(fetchResponse);
  }

  async insertTask(content: GoogleTaskInsert): Promise<GoogleTask> {
    const url =
        `https://tasks.googleapis.com/tasks/v1/lists/${this.listId}/tasks`;
    const fetchResponse = await fetch(
        url, this.auth.signRequest(
                 {method : "POST", body : JSON.stringify(content)}));
    console.log(JSON.stringify(content));
    return this.handleResponse(fetchResponse);
  }
}

export {authenticateFrom};
