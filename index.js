const axios = require('axios');

const token = 'BQDyyY8xQbrDEVs1oJxLvHHgb6z9TgDaDf3zJBtdtpncV15fEaUgin5NFHloOgLn-ACrNQdO-ZIDcoHSDOVniOFRR7TthPj9YwVTsadMIybgRXabBWeMJTBXZR6Y9qRyWyIURkui0aFifgXWM5nHcQn-Ojw4x-lm75LVo_5qQzkZ7DRqo6A192CAJ1jJ3Q30ngMdlTCY6itXaNuPappc5BE-UM91Gdi-6opDtuvdKgM_xYZN_fg';

const urlBase = 'https://api.spotify.com/v1/me';

do {
	axios.get(`${urlBase}/tracks`, {
		params: {
			limit: 50,
			offset: i
		}).
		then((res) => 

function printError(error) {
	if (error.response) {
		console.log(error.response.data);
		console.log(error.response.status);
		console.log(error.response.headers);
	} else if (error.request) {
		console.log(error.request);
	} else {
		console.log('Error', error.message);
	}
	console.log(error.config);
	throw 'Error';
}

const getTotal = () => {
	return axios.get(`${urlBase}/tracks`, {
		params: {
			limit: 1
		},
		headers: {
			'Authorization': `Bearer ${token}`
		}
	})
	.then((res) => res.data.total)
	.catch((error) => printError(error));
}

getTotal()
.then(total => console.log(total)) 
