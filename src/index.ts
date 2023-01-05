/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev src/index.ts` in your terminal to start a development
 * server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `wrangler publish src/index.ts --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import {
  authenticateFrom,
  GoogleAuthentication,
  GoogleTask,
  GoogleTaskInsert,
  TaskApi
} from "./googleHelper";

export interface Env {
  // Example binding to KV. Learn more at
  // https://developers.cloudflare.com/workers/runtime-apis/kv/ MY_KV_NAMESPACE:
  // KVNamespace;
  KV: KVNamespace;

  CLIENT_ID: string;
  CLIENT_SECRET: string;

  // Example binding to Durable Object. Learn more at
  // https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at
  // https://developers.cloudflare.com/workers/runtime-apis/r2/ MY_BUCKET:
  // R2Bucket;
}

interface TodoistDue {
  date: string
  is_recurring: boolean // TODO can't really deal with recurring tasks rn
}

interface TodoistTask {
  checked: boolean
  content: string
  description: string
  due: TodoistDue|null
  completed_at: string|null
  id: string
}

interface WebhookEvent {
  event_name: string
  user_id: string
  event_data: TodoistTask
}

async function todoistHanlderFromAuth(_event: WebhookEvent,
                                      auth: GoogleAuthentication, env: Env):
    Promise<TodoistWebHookHandler> {
  const listId =
      await env.KV.get("LIST_KEY") || "MDQxNjYxMjg3ODk5NzMwMTM2NzQ6MDow";
  return new TodoistWebHookHandler(_event, new TaskApi(listId, auth), env);
}

class TodoistWebHookHandler {
  event: WebhookEvent
  env: Env
  service: TaskApi

  constructor(_event: WebhookEvent, _service: TaskApi, _env: Env) {
    this.event = _event;
    this.service = _service;
    this.env = _env;
  }

  translateTask(): GoogleTaskInsert {
    const eventData = this.event.event_data;
    const result: GoogleTaskInsert = {
      title : eventData.content,
      notes : eventData.description,
    };
    if (eventData.due != null) {
      // Note: We are unable to enforce time of day here.
      result.due = new Date(eventData.due.date).toISOString();
      result.status = "needsAction";
    }
    if (eventData.checked) {
      result.completed =
          new Date(eventData.completed_at || new Date()).toISOString();
      result.status = "completed";
    }
    return result;
  }

  async createNewGoogleTask() {
    const tsk = await this.service.insertTask(this.translateTask());
    console.log(JSON.stringify(tsk));
    await this.putEventIdMapping(tsk.id);
  }

  async getTaskListId(): Promise<string> {
    const result = await this.env.KV.get(`taskList:${this.event.user_id}`);
    if (result == null)
      throw "Corupted DB";
    return result;
  }

  async putEventIdMapping(mappedToId: string) {
    const todoistId = this.event.event_data.id;
    await this.env.KV.put(`mapping:${todoistId}`, mappedToId);
  }

  async eventIdMapping(): Promise<string|null> {
    const todoistId = this.event.event_data.id;
    return await this.env.KV.get(`mapping:${todoistId}`, {type : "text"})
  }

  async doTranslate(): Promise<void> {
    console.debug("Event:", this.event);
    if (this.event.event_name == "item:added") {
      console.log("creating new task");
      await this.createNewGoogleTask();
      return;
    }
    const googleId = await this.eventIdMapping();
    console.debug(
        `task id translation: ${this.event.event_data.id} -> ${googleId}`);
    if (this.event.event_name == "item:deleted") {
      console.log("deleting task");
      const todoistId = this.event.event_data.id;
      // TODO handle task does not exist
      if (googleId) {
        await this.service.deleteTask(googleId);
        await this.env.KV.delete(`mapping:${todoistId}`);
      }
      return;
    }
    if (googleId == null) {
      console.log("cannot find given task, creating a new one");
      await this.createNewGoogleTask();
      return;
    }
    console.log("updating task");
    await this.service.updateTask(googleId, this.translateTask())
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  const body: WebhookEvent = await request.json();
  const auth = await authenticateFrom(body.user_id, env);
  if (auth != null) {
    console.debug(`found auth info for ${body.user_id}`);
    await (await todoistHanlderFromAuth(body, auth, env)).doTranslate();
  } else {
    console.debug(`todoist user: ${body.user_id} auth not found in our DB`);
  }
  return new Response("", {status : 200});
}

function isTodoistRoute(request: Request): boolean {
  const ctype = request.headers.get("content-type") || "";
  const url = new URL(request.url);
  // TODO: check x-app-id?
  return ctype === "application/json" && request.method == "POST" &&
         url.pathname.startsWith("/todoist-webhook/");
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext):
      Promise<Response> {
        if (isTodoistRoute(request))
          return handle(request, env);
        else
          return new Response(
              'Not found',
              {status : 404, headers : {'Content-Type' : 'plain'}});
      },
};
