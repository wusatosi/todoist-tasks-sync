import {JSONClient} from "google-auth-library/build/src/auth/googleauth";
import {google, tasks_v1} from "googleapis";

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

export interface Env {
  // Example binding to KV. Learn more at
  // https://developers.cloudflare.com/workers/runtime-apis/kv/ MY_KV_NAMESPACE:
  // KVNamespace;
  KV: KVNamespace;

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

async function getGoogleAuth(userId: string,
                             env: Env): Promise<JSONClient|null> {
  const creditial = await env.KV.get(`auth:${userId}`, {type : "json"});
  return creditial == null ? null : google.auth.fromJSON(creditial);
}

class TodoistWebHookHandler {
  event: WebhookEvent
  env: Env
  service: tasks_v1.Tasks

  constructor(_event: WebhookEvent, auth: JSONClient, _env: Env) {
    this.event = _event;
    this.service = google.tasks({version : "v1", auth});
    this.env = _env;
  }

  translateTask(): tasks_v1.Schema$Task {
    const eventData = this.event.event_data;
    const result: tasks_v1.Schema$Task = {
      title : eventData.content,
      notes : eventData.description,
    };
    if (eventData.due != null) {
      // Note: We are unable to enforce time of day here.
      result.due = eventData.due.date;
      result.status = "needsAction";
    } else {
      result.completed = eventData.completed_at;
      result.status = "completed";
    }
    return result;
  }

  async createNewGoogleTask() {
    const response = await this.service.tasks.insert({
      tasklist : await this.getTaskListId(),
      requestBody : this.translateTask()
    });
    // TODO: Error handle
    const newId = response.data.id;
    if (newId)
      await this.putEventIdMapping(newId);
  }

  async updateGoogleTask(googleId: string) {
    // TODO: error handle
    this.service.tasks.update({
      tasklist : await this.getTaskListId(),
      task : googleId,
      requestBody : this.translateTask()
    });
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
    if (this.event.event_name == "item:added") {
      console.debug("creating new task");
      this.createNewGoogleTask();
      return;
    }
    const googleId = await this.eventIdMapping();
    if (googleId == null) {
      console.log("cannot find given task, creating a new one");
      this.createNewGoogleTask();
      return;
    }
    console.log("updating task");
    this.updateGoogleTask(googleId)
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  const body: WebhookEvent = await request.json();
  const auth = await getGoogleAuth(body.user_id, env);
  if (auth != null)
    await new TodoistWebHookHandler(body, auth, env).doTranslate();
  return new Response("", {status : 200});
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext):
      Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/todoist-webhook/"))
          return handle(request, env);
        else
          return new Response(
              'Not found',
              {status : 404, headers : {'Content-Type' : 'plain'}});
      },
};
