const response = await fetch("http://localhost:3002/incoming-message", {
  method: "POST",
  headers: {
    "content-type": "application/json; charset=utf-8"
  },
  body: JSON.stringify({
    channel: "MAX",
    max_user_id: `test_utf8_${Date.now()}`,
    display_name: "Анна",
    message_text: "Здравствуйте, сколько стоит лечение кариеса и можно записаться завтра после 18:00?"
  })
});

const result = await response.json();
console.log(JSON.stringify(result, null, 2));
