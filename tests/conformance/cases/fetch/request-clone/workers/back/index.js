const encoder = new TextEncoder();

export default {
  fetch() {
    const parts = ["one,", "two,", "three"];
    return new Response(new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const part = parts.shift();
        if (part === undefined) controller.close();
        else controller.enqueue(encoder.encode(part));
      },
    }));
  },
};
